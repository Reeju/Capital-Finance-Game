// Local-first saves on IndexedDB via Dexie: one snapshot per accepted command plus the accepted command log.
import Dexie, { type Table } from 'dexie';
import { z } from 'zod';
import { validateContent } from '@capital/content';
import { type CommandEnvelope, type MatchState, RULES_VERSION, SCHEMA_VERSION, canonical, replay, sha256Hex, stateHash } from '@capital/engine';

export interface SaveMeta { mode: 'solo' | 'local'; humans: string[]; label: string; tutorial: boolean; coachDismissed?: boolean }
export interface SaveRow { id: string; revision: number; updatedAt: number; finished: boolean; meta: SaveMeta; state: MatchState; initial: MatchState }
export interface CommandRow { matchId: string; revision: number; envelope: CommandEnvelope }
export interface Settings { sound: boolean; reduceMotion: boolean; highContrast: boolean; fontScale: 100 | 115 | 130; analytics: boolean; name: string; color: string }
export const DEFAULT_SETTINGS: Settings = { sound: false, reduceMotion: false, highContrast: false, fontScale: 100, analytics: false, name: '', color: '#e4572e' };

class CapitalDb extends Dexie {
  saves!: Table<SaveRow, string>;
  commands!: Table<CommandRow, [string, number]>;
  kv!: Table<{ key: string; value: unknown }, string>;

  constructor() {
    super('capital');
    // Add new versions with .upgrade() migrations below; never edit a shipped version in place.
    this.version(1).stores({ saves: 'id, updatedAt', commands: '[matchId+revision], matchId', kv: 'key' });
  }
}

export const db = new CapitalDb();
export class SaveConflict extends Error {}

export async function createSave(state: MatchState, meta: SaveMeta): Promise<void> {
  await db.saves.put({ id: state.matchId, revision: state.revision, updatedAt: Date.now(), finished: false, meta, state, initial: state });
}

/** Snapshot + log entry in one transaction. Refuses to overwrite a newer revision written by another tab. */
export async function saveStep(state: MatchState, envelope: CommandEnvelope): Promise<void> {
  await db.transaction('rw', db.saves, db.commands, async () => {
    const row = await db.saves.get(state.matchId);
    if (!row) throw new SaveConflict('This save was deleted in another tab.');
    if (row.revision !== state.revision - 1) throw new SaveConflict('This match moved on in another tab.');
    await db.saves.update(state.matchId, { revision: state.revision, updatedAt: Date.now(), finished: state.phase === 'finished', state });
    await db.commands.put({ matchId: state.matchId, revision: state.revision, envelope });
  });
}

export async function updateMeta(id: string, meta: SaveMeta): Promise<void> {
  await db.saves.update(id, { meta });
}

export async function listSaves(): Promise<Pick<SaveRow, 'id' | 'revision' | 'updatedAt' | 'finished' | 'meta'>[]> {
  const rows = await db.saves.orderBy('updatedAt').reverse().toArray();
  return rows.map(({ id, revision, updatedAt, finished, meta }) => ({ id, revision, updatedAt, finished, meta }));
}

export async function deleteSave(id: string): Promise<void> {
  await db.transaction('rw', db.saves, db.commands, async () => {
    await db.saves.delete(id);
    await db.commands.where('matchId').equals(id).delete();
  });
}

export async function deleteEverything(): Promise<void> {
  await db.transaction('rw', db.saves, db.commands, db.kv, async () => {
    await Promise.all([db.saves.clear(), db.commands.clear(), db.kv.clear()]);
  });
}

export async function loadSettings(): Promise<Settings> {
  try {
    const row = await db.kv.get('settings');
    return { ...DEFAULT_SETTINGS, ...(row?.value as Partial<Settings> | undefined) };
  } catch {
    return DEFAULT_SETTINGS; // storage unavailable (private mode, quota): play on with defaults
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await db.kv.put({ key: 'settings', value: s });
}

// ---------- export / import ----------
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_LOG = 20_000;
interface ExportFile { format: 'capital-save'; schemaVersion: number; rulesVersion: string; meta: SaveMeta; initial: MatchState; commands: CommandEnvelope[]; hash: string; integrity: string }

export async function exportSave(id: string): Promise<string> {
  const row = await db.saves.get(id);
  if (!row) throw new Error('Save not found.');
  const commands = (await db.commands.where('matchId').equals(id).sortBy('revision')).map((c) => c.envelope);
  const body = { format: 'capital-save' as const, schemaVersion: SCHEMA_VERSION, rulesVersion: row.state.rulesVersion, meta: row.meta, initial: row.initial, commands, hash: stateHash(row.state) };
  // The integrity hash catches corruption. It does not prove who made the file: local saves are user-editable and unranked.
  const file: ExportFile = { ...body, integrity: sha256Hex(canonical(body)) };
  return JSON.stringify(file);
}

const metaSchema = z.object({ mode: z.enum(['solo', 'local']), humans: z.array(z.string().max(24)).max(4), label: z.string().max(80), tutorial: z.boolean(), coachDismissed: z.boolean().optional() });
const fileSchema = z.object({
  format: z.literal('capital-save'), schemaVersion: z.number().int(), rulesVersion: z.string().max(40), meta: metaSchema,
  initial: z.object({ matchId: z.string().max(64), revision: z.literal(0), content: z.unknown() }).passthrough(),
  commands: z.array(z.object({ commandId: z.string().max(64), expectedRevision: z.number().int() }).passthrough()).max(MAX_LOG),
  hash: z.string().length(64), integrity: z.string().length(64),
});

/** Validate an exported save and rebuild its state by replaying the log through the real engine. */
export async function importSave(text: string): Promise<string> {
  if (text.length > MAX_IMPORT_BYTES) throw new Error('That file is larger than the 10 MB import limit.');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('That file is not a Capital save.'); }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new Error('That file is not a valid Capital save.');
  const file = raw as ExportFile;
  if (file.schemaVersion > SCHEMA_VERSION || file.rulesVersion !== RULES_VERSION) {
    throw new Error(`This save was made with rules ${file.rulesVersion}. This build runs ${RULES_VERSION}; keep the file and open it with a matching build.`);
  }
  const { integrity, ...body } = file;
  if (sha256Hex(canonical(body)) !== integrity) throw new Error('This save file is corrupted (integrity check failed).');
  validateContent(file.initial.content); // content is data only; unknown fields or metrics are rejected
  let state: MatchState;
  try { state = replay(file.initial, file.commands); } catch { throw new Error('This save does not replay under the current rules.'); }
  if (stateHash(state) !== file.hash) throw new Error('This save does not replay to its recorded state.');
  await db.transaction('rw', db.saves, db.commands, async () => {
    await db.commands.where('matchId').equals(state.matchId).delete();
    await db.saves.put({ id: state.matchId, revision: state.revision, updatedAt: Date.now(), finished: state.phase === 'finished', meta: file.meta, state, initial: file.initial });
    await db.commands.bulkPut(file.commands.map((envelope, i) => ({ matchId: state.matchId, revision: i + 1, envelope })));
  });
  return state.matchId;
}
