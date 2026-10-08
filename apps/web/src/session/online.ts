// Online client. The server owns the state; this only mirrors seat projections and submits commands.
import { content } from '@capital/content';
import type { Command, CommandEnvelope, MatchState, SeatId } from '@capital/engine';
import { type Ack, type ClientMessage, type RoomConfig, type RoomPublic, type ServerMessage, type SubmitResult, PROTOCOL_VERSION } from '@capital/protocol';
import type { ChatLine, GameSession, View } from './types';

export const SERVER_BASE: string = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';
const BACKOFF = [1000, 2000, 4000, 8000, 15_000];

export async function createRoom(name: string, color: string, config: RoomConfig): Promise<string> {
  const res = await fetch(`${SERVER_BASE}/api/rooms`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, color, config }) });
  const body = (await res.json()) as { code?: string; error?: string };
  if (!res.ok || !body.code) throw new Error(body.error ?? 'Could not create a room.');
  return body.code;
}

export async function joinRoom(code: string, name: string, color: string): Promise<void> {
  const res = await fetch(`${SERVER_BASE}/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, color }) });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Could not join that room.');
}

export async function roomInfo(code: string): Promise<{ status: string; seats: number; maxSeats: number; mySeat: string | null } | null> {
  const res = await fetch(`${SERVER_BASE}/api/rooms/${encodeURIComponent(code)}`, { credentials: 'include' });
  return res.ok ? ((await res.json()) as { status: string; seats: number; maxSeats: number; mySeat: string | null }) : null;
}

export async function serverAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_BASE}/api/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

export class OnlineSession implements GameSession {
  private listeners = new Set<() => void>();
  private view: View | null = null;
  private ws: WebSocket | null = null;
  private state: MatchState | null = null;
  private room: RoomPublic | null = null;
  private seat: SeatId = '';
  private connection: View['connection'] = 'reconnecting';
  private deadline: number | null = null;
  private chatLog: ChatLine[] = [];
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, (ack: Ack | null) => void>();
  private error: string | null = null;
  private disposed = false;

  constructor(private code: string) {
    this.connect();
    window.addEventListener('offline', this.onOffline);
  }

  private onOffline = (): void => {
    this.ws?.close();
  };

  private connect(): void {
    if (this.disposed) return;
    const base = SERVER_BASE || window.location.origin;
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?room=${this.code}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.send({ t: 'hello', protocolVersion: PROTOCOL_VERSION, lastSeenRevision: this.state?.revision ?? -1 });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // In-flight commands are never resent blindly: the caller learns the outcome is unknown and re-checks state.
      for (const resolve of this.pending.values()) resolve(null);
      this.pending.clear();
      if (this.disposed || this.error === 'kicked') return;
      this.connection = navigator.onLine ? 'reconnecting' : 'offline';
      this.publish();
      const wait = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)];
      this.retry = setTimeout(() => this.connect(), wait + Math.floor(Math.random() * 400));
    };
  }

  private send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private setDeadline(deadline: number | null, serverTime: number): void {
    this.deadline = deadline === null ? null : deadline - serverTime + Date.now();
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.seat = msg.seatId;
        this.room = msg.room;
        if (msg.snapshot) this.state = msg.snapshot;
        this.setDeadline(msg.deadline, msg.serverTime);
        this.connection = 'ok';
        this.error = null;
        break;
      case 'room':
        this.room = msg.room;
        this.setDeadline(msg.room.deadline, msg.room.serverTime);
        break;
      case 'snapshot':
        this.state = msg.snapshot;
        this.setDeadline(msg.deadline, msg.serverTime);
        break;
      case 'delta':
        if (!this.state || msg.fromRevision !== this.state.revision) {
          this.send({ t: 'requestSnapshot' }); // missed a revision: ask for the truth rather than guessing
          return;
        }
        this.state = { ...msg.state, content: this.state.content ?? content, log: [...this.state.log, ...msg.events], journal: [] };
        this.setDeadline(msg.deadline, msg.serverTime);
        break;
      case 'ack': {
        const resolve = this.pending.get(msg.ack.commandId);
        this.pending.delete(msg.ack.commandId);
        resolve?.(msg.ack);
        return;
      }
      case 'chat':
        this.chatLog = [...this.chatLog.slice(-99), { from: msg.from, text: msg.text, at: msg.at }];
        break;
      case 'error':
        this.error = msg.code === 'kicked' ? 'kicked' : msg.message;
        break;
      case 'pong': return;
    }
    this.publish();
  }

  private publish(): void {
    const placeholder = this.state;
    this.view = placeholder && this.seat
      ? { state: placeholder, viewer: this.seat, mode: 'online', tutorial: false, coachDismissed: true, curtain: null, connection: this.connection, deadline: this.deadline, room: this.room, chat: this.chatLog, aiNote: null, readOnly: this.connection === 'ok' ? null : 'Reconnecting… the board is read-only until the connection returns.', saveError: null }
      : null;
    for (const l of this.listeners) l();
  }

  getRoom = (): RoomPublic | null => this.room;
  getSeat = (): SeatId => this.seat;
  getConnection = (): View['connection'] => this.connection;
  getView = (): View | null => this.view;
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  async submit(command: Command): Promise<SubmitResult> {
    if (!this.state || this.connection !== 'ok') return { ok: false, error: { code: 'offline', message: 'You are disconnected. Nothing was sent; try again once reconnected.' } };
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const env: CommandEnvelope = { matchId: this.state.matchId, commandId: 'c' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''), actorId: this.seat, expectedRevision: this.state.revision, rulesVersion: this.state.rulesVersion, command };
    const ack = await new Promise<Ack | null>((resolve) => {
      this.pending.set(env.commandId, resolve);
      if (!this.send({ t: 'command', envelope: env as ClientMessage extends { t: 'command'; envelope: infer E } ? E : never })) {
        this.pending.delete(env.commandId);
        resolve(null);
      }
    });
    if (!ack) return { ok: false, error: { code: 'unknown', message: 'Connection dropped mid-action. Check the board once reconnected before trying again.' } };
    return ack.accepted ? { ok: true } : { ok: false, error: ack.error };
  }

  confirmCurtain(): void {}
  dismissCoach(): void {}

  online = {
    ready: (ready: boolean) => void this.send({ t: 'ready', ready }),
    start: () => void this.send({ t: 'start' }),
    configure: (config: RoomConfig) => void this.send({ t: 'config', config }),
    addAi: (archetype: 'grace' | 'alex' | 'victor') => void this.send({ t: 'addAi', archetype }),
    kick: (seatId: SeatId) => void this.send({ t: 'kick', seatId }),
    chat: (text: string) => void this.send({ t: 'chat', text }),
    pauseVote: (paused: boolean) => void this.send({ t: 'pauseVote', paused }),
    lastError: () => this.error,
  };

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('offline', this.onOffline);
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.listeners.clear();
  }
}
