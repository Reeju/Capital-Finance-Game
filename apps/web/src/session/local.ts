// In-process authoritative host for solo and pass-and-play. Same engine, envelopes and validation as the server.
import { chooseAction } from '@capital/ai';
import { content } from '@capital/content';
import {
  type Archetype, type Command, type CommandEnvelope, type MatchState, type SeatId, applyCommand, createMatch, currentPrompt, getObservation,
} from '@capital/engine';
import type { SubmitResult } from '@capital/protocol';
import { type SaveMeta, SaveConflict, createSave, db, saveStep, updateMeta } from '../persistence/db';
import type { GameSession, View } from './types';

export interface LocalSetup { rounds: 12 | 20; tutorial: boolean; seats: { name: string; color: string; kind: 'human' | 'ai'; archetype?: Archetype }[] }

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function newLocalMatch(setup: LocalSetup): Promise<string> {
  const matchId = randomId('m');
  const seats = setup.seats.map((s, i) => ({ id: `s${i + 1}`, ...s }));
  const state = createMatch({ matchId, totalRounds: setup.rounds, seats, scenario: setup.tutorial ? 'tutorial' : 'normal' }, randomId('seed'), content);
  const humans = seats.filter((s) => s.kind === 'human').map((s) => s.id);
  const meta: SaveMeta = { mode: humans.length > 1 ? 'local' : 'solo', humans, tutorial: setup.tutorial, label: seats.map((s) => s.name).join(' vs ') };
  await createSave(state, meta);
  return matchId;
}

export class LocalSession implements GameSession {
  private listeners = new Set<() => void>();
  private view: View | null = null;
  private viewer: SeatId;
  private curtain: SeatId | null = null;
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  private aiNote: string | null = null;
  private saveError: string | null = null;
  private readOnly: string | null = null;
  private busy = false;
  private seq = 0;
  private releaseLock: (() => void) | null = null;
  private disposed = false;

  private constructor(private state: MatchState, private meta: SaveMeta, private aiDelayMs: number) {
    this.viewer = meta.humans[0] ?? state.seatOrder[0];
  }

  static async open(matchId: string, aiDelayMs = 650): Promise<LocalSession> {
    const row = await db.saves.get(matchId);
    if (!row) throw new Error('That save no longer exists.');
    const s = new LocalSession(row.state, row.meta, aiDelayMs);
    await s.acquireLock();
    s.settle(true);
    return s;
  }

  /** One writer per match across tabs (Web Locks). A second tab opens read-only instead of forking the save. */
  private async acquireLock(): Promise<void> {
    if (!('locks' in navigator)) return;
    await new Promise<void>((ready) => {
      void navigator.locks.request(`capital-match-${this.state.matchId}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          this.readOnly = 'This match is open in another tab. Close it there to play here.';
          ready();
          return undefined;
        }
        ready();
        return new Promise<void>((release) => { this.releaseLock = release; });
      });
    });
  }

  getView = (): View | null => this.view;
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private publish(): void {
    this.view = {
      state: getObservation(this.state, this.viewer).state, viewer: this.viewer, mode: this.meta.mode, tutorial: this.meta.tutorial,
      coachDismissed: !!this.meta.coachDismissed, curtain: this.curtain, connection: 'ok', deadline: null, room: null, chat: [], aiNote: this.aiNote,
      readOnly: this.readOnly, saveError: this.saveError,
    };
    for (const l of this.listeners) l();
  }

  /** After any state change: decide whose eyes are on the screen, and let AI seats take their move. */
  private settle(initial = false): void {
    const prompt = currentPrompt(this.state);
    if (prompt.kind !== 'none' && this.state.phase !== 'finished') {
      const seat = prompt.seat;
      if (this.state.players[seat].kind === 'human') {
        if (seat !== this.viewer || (initial && this.meta.humans.length > 1)) {
          if (this.meta.humans.length > 1) this.curtain = seat; // pass the device; nothing private shows until confirmed
          else this.viewer = seat;
        }
      } else if (!this.readOnly && !this.aiTimer) {
        this.aiTimer = setTimeout(() => {
          this.aiTimer = null;
          void this.aiMove(seat);
        }, this.aiDelayMs);
      }
    }
    this.publish();
  }

  private async aiMove(seat: SeatId): Promise<void> {
    if (this.disposed) return;
    const choice = chooseAction(getObservation(this.state, seat));
    let res = await this.commit(seat, choice?.command ?? { type: 'TimeoutTurn' });
    if (!res.ok) res = await this.commit('system', { type: 'TimeoutTurn' }); // an AI misjudgement never stalls the table
    if (res.ok && choice) this.aiNote = `${this.state.players[seat].name} ${choice.why}.`;
    this.settle();
  }

  private async commit(actor: SeatId | 'system', command: Command): Promise<SubmitResult> {
    if (this.readOnly) return { ok: false, error: { code: 'read_only', message: this.readOnly } };
    if (this.busy) return { ok: false, error: { code: 'busy', message: 'Still saving the previous action.' } };
    this.busy = true;
    try {
      const env: CommandEnvelope = { matchId: this.state.matchId, commandId: `l${++this.seq}-${this.state.revision}`, actorId: actor, expectedRevision: this.state.revision, rulesVersion: this.state.rulesVersion, command };
      const r = applyCommand(this.state, env);
      if (!r.ok) return { ok: false, error: r.error };
      try {
        await saveStep(r.state, env);
        this.saveError = null;
      } catch (e) {
        if (e instanceof SaveConflict) {
          this.readOnly = `${e.message} Reload to continue from the saved position.`;
          return { ok: false, error: { code: 'conflict', message: this.readOnly } };
        }
        // Storage failed (quota, private mode). Keep playing in memory and say so plainly.
        this.saveError = 'Could not save to this device. The match continues, but progress may be lost if you close the tab. Export a backup from Settings.';
      }
      this.state = r.state;
      return { ok: true };
    } finally {
      this.busy = false;
    }
  }

  async submit(command: Command): Promise<SubmitResult> {
    if (this.curtain) return { ok: false, error: { code: 'curtain', message: 'Confirm the seat first.' } };
    if (command.type === 'TimeoutTurn') return { ok: false, error: { code: 'forbidden', message: 'Not a player command.' } };
    const res = await this.commit(this.viewer, command);
    if (res.ok) this.aiNote = null;
    this.settle();
    return res;
  }

  confirmCurtain(): void {
    if (!this.curtain) return;
    this.viewer = this.curtain;
    this.curtain = null;
    this.publish();
  }

  dismissCoach(): void {
    this.meta = { ...this.meta, coachDismissed: true };
    void updateMeta(this.state.matchId, this.meta).catch(() => undefined);
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.releaseLock?.();
    this.listeners.clear();
  }
}
