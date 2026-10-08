// Minimal test client: real HTTP + WebSocket against a real server process-in-test.
import { WebSocket } from 'ws';
import { chooseAction } from '@capital/ai';
import { content } from '@capital/content';
import { type Command, type CommandEnvelope, type MatchState, currentPrompt } from '@capital/engine';
import { type Ack, type ClientMessage, type RoomPublic, type ServerMessage, DEFAULT_ROOM_CONFIG, PROTOCOL_VERSION } from '@capital/protocol';

let seq = 0;
export class TestClient {
  cookie = '';
  seatId = '';
  code = '';
  ws: WebSocket | null = null;
  state: MatchState | null = null;
  room: RoomPublic | null = null;
  received: ServerMessage[] = [];
  raw: string[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; ok: (m: ServerMessage) => void }[] = [];

  constructor(public base: string, public origin = 'http://localhost:5173') {}

  private async post(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: this.origin, cookie: this.cookie }, body: JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return res;
  }

  async create(name: string, config = DEFAULT_ROOM_CONFIG): Promise<string> {
    const res = await this.post('/api/rooms', { name, color: '#e4572e', config });
    const body = (await res.json()) as { code: string; seatId: string };
    this.code = body.code;
    this.seatId = body.seatId;
    return body.code;
  }

  async join(code: string, name: string): Promise<Response> {
    const res = await this.post(`/api/rooms/${code}/join`, { name, color: '#2e86ab' });
    if (res.ok) {
      const body = (await res.clone().json()) as { seatId: string };
      this.code = code;
      this.seatId = body.seatId;
    }
    return res;
  }

  connect(opts: { cookie?: string; origin?: string; code?: string } = {}): Promise<void> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(`${this.base.replace('http', 'ws')}/ws?room=${opts.code ?? this.code}`, { headers: { cookie: opts.cookie ?? this.cookie, origin: opts.origin ?? this.origin } });
      this.ws = ws;
      ws.on('open', () => {
        this.send({ t: 'hello', protocolVersion: PROTOCOL_VERSION, lastSeenRevision: this.state?.revision ?? -1 });
        ok();
      });
      ws.on('unexpected-response', (_req, res) => fail(new Error(`upgrade refused ${res.statusCode}`)));
      ws.on('error', fail);
      ws.on('message', (raw) => {
        const text = raw.toString();
        this.raw.push(text);
        const msg = JSON.parse(text) as ServerMessage;
        this.received.push(msg);
        if (msg.t === 'welcome') { this.room = msg.room; if (msg.snapshot) this.state = msg.snapshot; }
        if (msg.t === 'room') this.room = msg.room;
        if (msg.t === 'snapshot') this.state = msg.snapshot;
        if (msg.t === 'delta' && this.state) this.state = { ...msg.state, content: this.state.content ?? content, log: [...this.state.log, ...msg.events], journal: [] };
        this.waiters = this.waiters.filter((w) => { if (w.pred(msg)) { w.ok(msg); return false; } return true; });
      });
    });
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(msg));
  }

  waitFor<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 10_000): Promise<Extract<ServerMessage, { t: T }>> {
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`timed out waiting for ${t}`)), ms);
      this.waiters.push({ pred: (m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>), ok: (m) => { clearTimeout(timer); ok(m as Extract<ServerMessage, { t: T }>); } });
    });
  }

  /** Poll local state: immune to the message having arrived before we started waiting. */
  async until(pred: () => boolean, ms = 10_000): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
      await new Promise((r) => setTimeout(r, 3));
    }
  }

  envelope(command: Command, overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
    if (!this.state) throw new Error('no state');
    return { matchId: this.state.matchId, commandId: `test-${this.seatId}-${++seq}-${Date.now()}`, actorId: this.seatId, expectedRevision: this.state.revision, rulesVersion: this.state.rulesVersion, command, ...overrides };
  }

  async command(command: Command, overrides: Partial<CommandEnvelope> = {}): Promise<Ack> {
    const env = this.envelope(command, overrides);
    return this.sendEnvelope(env);
  }

  async sendEnvelope(env: CommandEnvelope): Promise<Ack> {
    const p = this.waitFor('ack', (m) => m.ack.commandId === env.commandId);
    this.send({ t: 'command', envelope: env });
    return (await p).ack;
  }

  myTurn(): boolean {
    if (!this.state || this.state.phase === 'finished') return false;
    const p = currentPrompt(this.state);
    return p.kind !== 'none' && p.seat === this.seatId;
  }

  /** Play this seat with the heuristic AI on its own observation until the match ends. */
  async autoplay(until: () => boolean): Promise<void> {
    while (!until()) {
      if (this.myTurn() && this.state) {
        const choice = chooseAction({ seat: this.seatId, state: this.state }, 'alex');
        const ack = await this.command(choice?.command ?? { type: 'EndTurn' });
        if (!ack.accepted && ack.error?.code !== 'stale') await this.command({ type: 'EndTurn' }).catch(() => undefined);
      } else await new Promise((r) => setTimeout(r, 5));
    }
  }

  close(): Promise<void> {
    return new Promise((ok) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return ok();
      this.ws.once('close', () => ok());
      this.ws.close();
    });
  }
}
