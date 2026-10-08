// Authoritative rooms: lobby, seat sessions, the single command path, deadlines, reconnect grace and AI seats.
import { createHash, randomBytes } from 'node:crypto';
import { chooseAction } from '@capital/ai';
import { content } from '@capital/content';
import {
  type Archetype, type Command, type CommandEnvelope, type GameEvent, type MatchState, type SeatId, RULES_VERSION, applyCommand, createMatch,
  currentPrompt, getObservation, projectEvents, replay, stateHash,
} from '@capital/engine';
import { type Ack, type ClientMessage, type RoomConfig, type RoomPublic, type ServerMessage, PROTOCOL_VERSION, roomCodeFromBytes, slim } from '@capital/protocol';
import type { Repository } from './repository';

export interface Timings { turnMs: number; relaxedTurnMs: number; responseMs: number; graceMs: number; aiDelayMs: number; suspendMs: number }
export const DEFAULT_TIMINGS: Timings = { turnMs: 90_000, relaxedTurnMs: 300_000, responseMs: 30_000, graceMs: 120_000, aiDelayMs: 700, suspendMs: 24 * 3600_000 };
export interface Conn { send(msg: ServerMessage): void; close(): void }

interface SeatRecord {
  seatId: SeatId; name: string; color: string; kind: 'human' | 'ai'; archetype?: Archetype; tokenHash: string | null; ready: boolean; host: boolean;
  graceUsed: number; aiControlled: boolean;
}
interface RoomData {
  code: string; status: 'lobby' | 'playing' | 'finished'; config: RoomConfig; seats: SeatRecord[]; deadline: number | null; pauseVotes: SeatId[];
  commandSeq: number;
}

const COLORS = ['#e4572e', '#2e86ab', '#76b041', '#a23b72'];
const AI_NAMES: Record<Archetype, string> = { grace: 'Grace', alex: 'Alex', victor: 'Victor' };
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

class Bucket {
  private tokens: number;
  private last: number;
  constructor(private rate: number, private burst: number, now: number) {
    this.tokens = burst;
    this.last = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class Room {
  data: RoomData;
  state: MatchState | null = null;
  private conns = new Map<SeatId, Conn>();
  private disconnectedAt = new Map<SeatId, number>();
  private commandBuckets = new Map<SeatId, Bucket>();
  private chatBuckets = new Map<SeatId, Bucket>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  lastActive: number;

  constructor(data: RoomData, private repo: Repository, private timings: Timings, private now: () => number) {
    this.data = data;
    this.lastActive = now();
  }

  // ---------- persistence ----------
  private serialize(): string {
    return JSON.stringify(this.data);
  }
  private saveRoom(): void {
    this.repo.saveRoom(this.data.code, this.serialize(), this.now());
  }

  /** Restore after a server restart: reload the match and give the prompted seat a fresh clock. */
  restore(): void {
    if (this.data.status === 'lobby') return;
    const m = this.repo.loadMatch(this.data.code);
    if (!m) {
      this.data.status = 'lobby';
      return;
    }
    this.state = m.state;
    this.data.deadline = null;
    this.data.pauseVotes = [];
  }

  // ---------- views ----------
  get paused(): boolean {
    const humans = this.connectedHumans();
    return this.data.status === 'playing' && humans.length > 0 && humans.every((s) => this.data.pauseVotes.includes(s));
  }

  private connectedHumans(): SeatId[] {
    return this.data.seats.filter((s) => s.kind === 'human' && this.conns.has(s.seatId)).map((s) => s.seatId);
  }

  publicView(): RoomPublic {
    return {
      code: this.data.code, status: this.data.status, config: this.data.config, paused: this.paused, pauseVotes: this.data.pauseVotes,
      rulesVersion: RULES_VERSION, contentVersion: content.version, deadline: this.data.deadline, serverTime: this.now(),
      seats: this.data.seats.map((s) => ({
        seatId: s.seatId, name: s.name, color: s.color, kind: s.kind, ready: s.kind === 'ai' || s.ready, host: s.host,
        connected: s.kind === 'ai' || this.conns.has(s.seatId), aiControlled: s.aiControlled,
      })),
    };
  }

  private broadcast(f: (seat: SeatId) => ServerMessage): void {
    for (const [seat, conn] of this.conns) conn.send(f(seat));
  }
  private broadcastRoom(): void {
    const room = this.publicView();
    this.broadcast(() => ({ t: 'room', room }));
  }

  // ---------- seats ----------
  seatByToken(token: string): SeatRecord | undefined {
    const h = hashToken(token);
    return this.data.seats.find((s) => s.tokenHash === h);
  }

  addHuman(name: string, color: string): { seatId: SeatId; token: string } | { error: string } {
    if (this.data.status !== 'lobby') return { error: 'This match has already started.' };
    if (this.data.seats.length >= this.data.config.maxSeats) return { error: 'The room is full.' };
    const token = randomBytes(32).toString('base64url');
    const seatId = this.nextSeatId();
    const used = new Set(this.data.seats.map((s) => s.color));
    this.data.seats.push({
      seatId, name, color: used.has(color) ? COLORS.find((c) => !used.has(c)) ?? color : color, kind: 'human', tokenHash: hashToken(token), ready: false,
      host: this.data.seats.every((s) => !s.host), graceUsed: 0, aiControlled: false,
    });
    this.saveRoom();
    this.broadcastRoom();
    return { seatId, token };
  }

  private nextSeatId(): SeatId {
    for (let i = 1; i <= 4; i++) if (!this.data.seats.some((s) => s.seatId === `s${i}`)) return `s${i}`;
    throw new Error('room full');
  }

  attach(seatId: SeatId, conn: Conn): void {
    this.conns.get(seatId)?.close();
    this.conns.set(seatId, conn);
    this.disconnectedAt.delete(seatId);
    this.lastActive = this.now();
    const seat = this.data.seats.find((s) => s.seatId === seatId);
    if (seat?.aiControlled) seat.aiControlled = false; // the player is back; they act again from their next prompt
    this.broadcastRoom();
    if (this.data.status === 'playing' && !this.timer) this.schedule(true);
  }

  detach(seatId: SeatId, conn: Conn): void {
    if (this.conns.get(seatId) !== conn) return;
    this.conns.delete(seatId);
    this.disconnectedAt.set(seatId, this.now());
    this.lastActive = this.now();
    this.data.pauseVotes = this.data.pauseVotes.filter((s) => s !== seatId);
    if (this.data.status === 'lobby') {
      const seat = this.data.seats.find((s) => s.seatId === seatId);
      if (seat) seat.ready = false;
      if (seat?.host) this.transferHost();
      this.saveRoom();
    } else if (this.data.status === 'playing' && this.state) {
      if (this.connectedHumans().length === 0) {
        this.clearTimer(); // everyone is gone: suspend, keep state, resume on the next connection
        this.data.deadline = null;
        this.saveRoom();
      } else {
        const prompt = currentPrompt(this.state);
        const seat = this.data.seats.find((s) => s.seatId === seatId);
        if (prompt.kind !== 'none' && prompt.seat === seatId && seat && seat.graceUsed < 2 && this.data.deadline !== null) {
          seat.graceUsed += 1;
          this.data.deadline = Math.max(this.data.deadline, this.now() + this.timings.graceMs);
          this.saveRoom();
          this.armTimer();
        }
      }
    }
    this.broadcastRoom();
  }

  private transferHost(): void {
    for (const s of this.data.seats) s.host = false;
    const next = this.data.seats.find((s) => s.kind === 'human' && this.conns.has(s.seatId)) ?? this.data.seats.find((s) => s.kind === 'human');
    if (next) next.host = true;
  }

  hasConnections(): boolean {
    return this.conns.size > 0;
  }

  // ---------- messages ----------
  handle(seatId: SeatId, conn: Conn, msg: ClientMessage): void {
    this.lastActive = this.now();
    const seat = this.data.seats.find((s) => s.seatId === seatId);
    if (!seat) return;
    const err = (code: string, message: string) => conn.send({ t: 'error', code, message });
    switch (msg.t) {
      case 'hello':
        if (msg.protocolVersion !== PROTOCOL_VERSION) return err('protocol', 'Your game needs an update to join this room.');
        conn.send({
          t: 'welcome', protocolVersion: PROTOCOL_VERSION, seatId, room: this.publicView(), snapshot: this.state ? getObservation(this.state, seatId).state : null,
          revision: this.state?.revision ?? 0, deadline: this.data.deadline, serverTime: this.now(),
        });
        return;
      case 'requestSnapshot':
        if (this.state) conn.send({ t: 'snapshot', snapshot: getObservation(this.state, seatId).state, revision: this.state.revision, deadline: this.data.deadline, serverTime: this.now() });
        return;
      case 'ping': conn.send({ t: 'pong', n: msg.n }); return;
      case 'chat': {
        const b = this.chatBuckets.get(seatId) ?? new Bucket(0.5, 5, this.now());
        this.chatBuckets.set(seatId, b);
        if (!b.take(this.now())) return err('rate', 'You are sending messages too quickly.');
        const text = msg.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
        if (text) this.broadcast(() => ({ t: 'chat', from: seatId, text, at: this.now() }));
        return;
      }
      case 'command': this.onCommand(seatId, conn, msg.envelope as CommandEnvelope); return;
      case 'pauseVote':
        if (this.data.status !== 'playing') return;
        this.data.pauseVotes = msg.paused ? [...new Set([...this.data.pauseVotes, seatId])] : this.data.pauseVotes.filter((s) => s !== seatId);
        if (this.paused) {
          this.clearTimer();
          this.data.deadline = null;
        } else if (!this.timer) this.schedule(true);
        this.saveRoom();
        this.broadcastRoom();
        return;
    }
    if (this.data.status !== 'lobby') return err('started', 'The match has already started; room settings are locked.');
    switch (msg.t) {
      case 'ready': seat.ready = msg.ready; break;
      case 'config':
        if (!seat.host) return err('host_only', 'Only the host can change room settings.');
        if (msg.config.maxSeats < this.data.seats.length) return err('too_small', 'Remove a seat before shrinking the room.');
        this.data.config = msg.config;
        break;
      case 'addAi': {
        if (!seat.host) return err('host_only', 'Only the host can add AI seats.');
        if (this.data.seats.length >= this.data.config.maxSeats) return err('full', 'The room is full.');
        const used = new Set(this.data.seats.map((s) => s.color));
        this.data.seats.push({ seatId: this.nextSeatId(), name: AI_NAMES[msg.archetype], color: COLORS.find((c) => !used.has(c)) ?? '#888888', kind: 'ai', archetype: msg.archetype, tokenHash: null, ready: true, host: false, graceUsed: 0, aiControlled: false });
        break;
      }
      case 'kick': {
        if (!seat.host || msg.seatId === seatId) return err('host_only', 'Only the host can remove other seats.');
        this.data.seats = this.data.seats.filter((s) => s.seatId !== msg.seatId);
        const c = this.conns.get(msg.seatId);
        if (c) {
          c.send({ t: 'error', code: 'kicked', message: 'The host removed you from the room.' });
          this.conns.delete(msg.seatId);
          c.close();
        }
        break;
      }
      case 'start': {
        if (!seat.host) return err('host_only', 'Only the host can start the match.');
        if (this.data.seats.length < 2) return err('too_few', 'A match needs at least two seats.');
        if (this.data.seats.some((s) => s.kind === 'human' && !s.host && !s.ready)) return err('not_ready', 'Everyone needs to be ready.');
        this.start();
        return;
      }
    }
    this.saveRoom();
    this.broadcastRoom();
  }

  private start(): void {
    const seed = randomBytes(16).toString('hex'); // never leaves the server
    const state = createMatch({
      matchId: this.data.code, totalRounds: this.data.config.totalRounds, scenario: 'normal',
      seats: this.data.seats.map((s) => ({ id: s.seatId, name: s.name, color: s.color, kind: s.kind, archetype: s.archetype })),
    }, seed, content);
    this.state = state;
    this.data.status = 'playing';
    this.data.deadline = null;
    this.repo.startMatch(this.data.code, this.serialize(), state, this.now());
    this.schedule(true);
    const room = this.publicView();
    this.broadcast((s) => ({ t: 'welcome', protocolVersion: PROTOCOL_VERSION, seatId: s, room, snapshot: getObservation(state, s).state, revision: state.revision, deadline: this.data.deadline, serverTime: this.now() }));
  }

  private onCommand(seatId: SeatId, conn: Conn, env: CommandEnvelope): void {
    const nack = (code: string, message: string): Ack => ({ commandId: env.commandId, accepted: false, revision: this.state?.revision ?? 0, error: { code, message } });
    if (!this.state || this.data.status !== 'playing') return conn.send({ t: 'ack', ack: nack('not_playing', 'No match is in progress.') });
    const stored = this.repo.getAck(this.data.code, env.commandId);
    if (stored) return conn.send({ t: 'ack', ack: stored }); // duplicate delivery: same answer, no second execution
    const b = this.commandBuckets.get(seatId) ?? new Bucket(10, 20, this.now());
    this.commandBuckets.set(seatId, b);
    if (!b.take(this.now())) return conn.send({ t: 'ack', ack: nack('rate', 'Slow down a little.') });
    if (env.actorId !== seatId || env.matchId !== this.data.code) return conn.send({ t: 'ack', ack: nack('forbidden', 'You can only act for your own seat in this room.') });
    if (this.paused) return conn.send({ t: 'ack', ack: nack('paused', 'The room is paused.') });
    conn.send({ t: 'ack', ack: this.commit(env) });
  }

  /** The one write path: engine -> one DB transaction -> broadcast. Nothing is acknowledged before it is durable. */
  private commit(env: CommandEnvelope): Ack {
    const state = this.state;
    if (!state) return { commandId: env.commandId, accepted: false, revision: 0, error: { code: 'not_playing', message: 'No match is in progress.' } };
    let result;
    try {
      result = applyCommand(state, env);
    } catch (e) {
      console.error(`[room ${this.data.code}] engine error`, e instanceof Error ? e.message : 'unknown');
      return { commandId: env.commandId, accepted: false, revision: state.revision, error: { code: 'internal', message: 'The server could not process that command.' } };
    }
    if (!result.ok) return { commandId: env.commandId, accepted: false, revision: state.revision, error: result.error };
    const next = result.state;
    const ack: Ack = { commandId: env.commandId, accepted: true, revision: next.revision };
    const before = { status: this.data.status, deadline: this.data.deadline };
    if (next.phase === 'finished') this.data.status = 'finished';
    this.data.deadline = this.computeDeadline(next);
    try {
      this.repo.commit(this.data.code, this.serialize(), next, env, ack, this.now());
    } catch (e) {
      Object.assign(this.data, before); // not durable, so it did not happen
      console.error(`[room ${this.data.code}] persist failed`, e instanceof Error ? e.message : 'unknown');
      return { commandId: env.commandId, accepted: false, revision: state.revision, error: { code: 'internal', message: 'The server could not save that command.' } };
    }
    this.state = next;
    this.fanOut(state.revision, next, result.events);
    this.armTimer();
    return ack;
  }

  private fanOut(fromRevision: number, next: MatchState, events: GameEvent[]): void {
    this.broadcast((seat) => ({
      t: 'delta', fromRevision, toRevision: next.revision, events: projectEvents(events, seat), state: slim(getObservation(next, seat).state),
      deadline: this.data.deadline, serverTime: this.now(),
    }));
    if (next.phase === 'finished') this.broadcastRoom();
  }

  // ---------- clocks ----------
  private isAiSeat(seatId: SeatId): boolean {
    const s = this.data.seats.find((x) => x.seatId === seatId);
    return !!s && (s.kind === 'ai' || s.aiControlled);
  }

  private computeDeadline(state: MatchState): number | null {
    const prompt = currentPrompt(state);
    if (state.phase === 'finished' || prompt.kind === 'none') return null;
    if (this.isAiSeat(prompt.seat)) return this.now() + this.timings.aiDelayMs;
    const turn = this.data.config.pacing === 'relaxed' ? this.timings.relaxedTurnMs : this.timings.turnMs;
    return this.now() + (prompt.kind === 'turn' || prompt.kind === 'rescue' ? turn : this.timings.responseMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private armTimer(): void {
    this.clearTimer();
    if (this.data.deadline === null || this.data.status !== 'playing') return;
    this.timer = setTimeout(() => this.onDeadline(), Math.max(0, this.data.deadline - this.now()));
  }

  /** (Re)start the clock for whoever is prompted, e.g. after start, restore, unpause or a room waking up. */
  schedule(fresh: boolean): void {
    if (!this.state || this.data.status !== 'playing' || this.paused) return;
    if (this.connectedHumans().length === 0 && this.data.seats.some((s) => s.kind === 'human')) return;
    if (fresh || this.data.deadline === null) this.data.deadline = this.computeDeadline(this.state);
    this.saveRoom();
    this.armTimer();
    this.broadcastRoom();
  }

  private onDeadline(): void {
    this.timer = null;
    const state = this.state;
    if (!state || this.data.status !== 'playing' || this.paused) return;
    if (this.data.deadline !== null && this.now() < this.data.deadline) return this.armTimer();
    const prompt = currentPrompt(state);
    if (prompt.kind === 'none') return;
    const seat = this.data.seats.find((s) => s.seatId === prompt.seat);
    if (!seat) return;
    if (seat.kind === 'human' && !seat.aiControlled && !this.conns.has(seat.seatId) && this.data.config.disconnectPolicy === 'ai') {
      seat.aiControlled = true; // agreed room policy: a named AI covers the absent seat until they return
      this.broadcastRoom();
    }
    let command: Command = { type: 'TimeoutTurn' };
    let actor: SeatId | 'system' = 'system';
    if (this.isAiSeat(seat.seatId)) {
      const choice = chooseAction(getObservation(state, seat.seatId), seat.archetype ?? 'grace');
      if (choice) {
        command = choice.command;
        actor = seat.seatId;
      }
    }
    const env = (a: SeatId | 'system', c: Command): CommandEnvelope => ({ matchId: state.matchId, commandId: `srv-${this.data.code}-${++this.data.commandSeq}`, actorId: a, expectedRevision: state.revision, rulesVersion: state.rulesVersion, command: c });
    let ack = this.commit(env(actor, command));
    if (!ack.accepted && actor !== 'system') ack = this.commit(env('system', { type: 'TimeoutTurn' })); // an AI misjudgement never stalls the room
    if (!ack.accepted) console.error(`[room ${this.data.code}] deadline command rejected: ${ack.error?.code}`);
  }

  /** Server-internal determinism audit: replaying the accepted log from the initial state must reproduce the live state. */
  auditReplay(): { ok: boolean; liveHash: string; replayHash: string; commands: number } {
    const m = this.repo.loadMatch(this.data.code);
    if (!m) return { ok: false, liveHash: '', replayHash: '', commands: 0 };
    const cmds = this.repo.loadCommands(this.data.code);
    const replayHash = stateHash(replay(m.initial, cmds));
    const liveHash = stateHash(m.state);
    return { ok: replayHash === liveHash, liveHash, replayHash, commands: cmds.length };
  }

  shutdown(): void {
    this.clearTimer();
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }
}

export class RoomManager {
  rooms = new Map<string, Room>();
  private sweep: ReturnType<typeof setInterval> | null = null;

  constructor(private repo: Repository, private timings: Timings = DEFAULT_TIMINGS, private now: () => number = Date.now) {
    for (const row of repo.loadRooms()) {
      if (this.now() - row.updated > timings.suspendMs) {
        repo.deleteRoom(row.code);
        continue;
      }
      const room = new Room(JSON.parse(row.data) as RoomData, repo, timings, this.now);
      room.restore();
      this.rooms.set(room.data.code, room);
    }
    this.sweep = setInterval(() => this.expire(), 60_000);
    this.sweep.unref?.();
  }

  create(config: RoomConfig, name: string, color: string): { room: Room; seatId: SeatId; token: string } {
    let code = roomCodeFromBytes(randomBytes(8));
    while (this.rooms.has(code)) code = roomCodeFromBytes(randomBytes(8));
    const room = new Room({ code, status: 'lobby', config, seats: [], deadline: null, pauseVotes: [], commandSeq: 0 }, this.repo, this.timings, this.now);
    this.rooms.set(code, room);
    const seat = room.addHuman(name, color);
    if ('error' in seat) throw new Error(seat.error);
    return { room, ...seat };
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  /** Abandoned rooms (nobody connected for the retention window) are deleted with their match data. */
  expire(): void {
    for (const [code, room] of this.rooms) {
      if (!room.hasConnections() && this.now() - room.lastActive > this.timings.suspendMs) {
        room.shutdown();
        this.repo.deleteRoom(code);
        this.rooms.delete(code);
      }
    }
  }

  shutdown(): void {
    if (this.sweep) clearInterval(this.sweep);
    for (const r of this.rooms.values()) r.shutdown();
  }
}
