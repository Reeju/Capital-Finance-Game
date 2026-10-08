// Durable room storage on SQLite (node:sqlite). One process, prepared statements, one transaction per accepted command.
import { DatabaseSync } from 'node:sqlite';
import type { CommandEnvelope, MatchState } from '@capital/engine';
import type { Ack } from '@capital/protocol';

export interface StoredRoom { code: string; data: string; updated: number }

export class Repository {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS matches (code TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, initial TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (code TEXT NOT NULL, command_id TEXT NOT NULL, revision INTEGER NOT NULL, envelope TEXT NOT NULL, ack TEXT NOT NULL, PRIMARY KEY (code, command_id));
    `);
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema', '1');
  }

  private tx<T>(f: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = f();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  saveRoom(code: string, data: string, now: number): void {
    this.db.prepare('INSERT INTO rooms (code, data, updated) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET data = excluded.data, updated = excluded.updated').run(code, data, now);
  }

  startMatch(code: string, roomData: string, initial: MatchState, now: number): void {
    this.tx(() => {
      const json = JSON.stringify(initial);
      this.db.prepare('INSERT OR REPLACE INTO matches (code, revision, state, initial) VALUES (?, ?, ?, ?)').run(code, initial.revision, json, json);
      this.saveRoom(code, roomData, now);
    });
  }

  /** New state, the accepted command with its acknowledgement, and the room row (deadline) commit together or not at all. */
  commit(code: string, roomData: string, state: MatchState, envelope: CommandEnvelope, ack: Ack, now: number): void {
    this.tx(() => {
      this.db.prepare('UPDATE matches SET revision = ?, state = ? WHERE code = ?').run(state.revision, JSON.stringify(state), code);
      this.db.prepare('INSERT INTO commands (code, command_id, revision, envelope, ack) VALUES (?, ?, ?, ?, ?)').run(code, envelope.commandId, state.revision, JSON.stringify(envelope), JSON.stringify(ack));
      this.saveRoom(code, roomData, now);
    });
  }

  getAck(code: string, commandId: string): Ack | null {
    const row = this.db.prepare('SELECT ack FROM commands WHERE code = ? AND command_id = ?').get(code, commandId) as { ack: string } | undefined;
    return row ? (JSON.parse(row.ack) as Ack) : null;
  }

  loadRooms(): StoredRoom[] {
    return this.db.prepare('SELECT code, data, updated FROM rooms').all() as unknown as StoredRoom[];
  }

  loadMatch(code: string): { state: MatchState; initial: MatchState } | null {
    const row = this.db.prepare('SELECT state, initial FROM matches WHERE code = ?').get(code) as { state: string; initial: string } | undefined;
    return row ? { state: JSON.parse(row.state) as MatchState, initial: JSON.parse(row.initial) as MatchState } : null;
  }

  loadCommands(code: string): CommandEnvelope[] {
    const rows = this.db.prepare('SELECT envelope FROM commands WHERE code = ? ORDER BY revision').all(code) as unknown as { envelope: string }[];
    return rows.map((r) => JSON.parse(r.envelope) as CommandEnvelope);
  }

  deleteRoom(code: string): void {
    this.tx(() => {
      for (const t of ['rooms', 'matches', 'commands']) this.db.prepare(`DELETE FROM ${t} WHERE code = ?`).run(code);
    });
  }

  close(): void {
    this.db.close();
  }
}
