// HTTP + WebSocket front door. Sessions are anonymous seat tokens in HttpOnly cookies; the room code is not a credential.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type WebSocket, WebSocketServer } from 'ws';
import { type ServerMessage, MAX_PAYLOAD_BYTES, clientMessageSchema, createRoomSchema, isRoomCode, joinRoomSchema } from '@capital/protocol';
import { Repository } from './repository';
import { type Conn, type Timings, DEFAULT_TIMINGS, RoomManager } from './rooms';

export interface ServerOptions { port: number; dbPath: string; allowedOrigins: string[]; timings?: Partial<Timings>; staticDir?: string; secureCookies?: boolean; roomsPerHour?: number }

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const CSP = "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function startServer(opts: ServerOptions) {
  const repo = new Repository(opts.dbPath);
  const manager = new RoomManager(repo, { ...DEFAULT_TIMINGS, ...opts.timings });
  const creations = new Map<string, number[]>();
  const perHour = opts.roomsPerHour ?? 5;

  const originOk = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return false;
    if (opts.allowedOrigins.includes(origin)) return true;
    // same-origin deployments: the page was served by this server
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  };
  const isLocal = (req: IncomingMessage) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host ?? '');
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const seatCookie = (req: IncomingMessage, code: string, token: string) => {
    // Secure everywhere except plain-http localhost development.
    const secure = opts.secureCookies ?? !isLocal(req);
    return `cap_${code}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=172800${secure ? '; Secure' : ''}`;
  };
  const readBody = (req: IncomingMessage): Promise<unknown> => new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_PAYLOAD_BYTES) { fail(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { fail(new Error('bad json')); } });
    req.on('error', fail);
  });

  const api = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    if (path === '/api/health') return json(res, 200, { ok: true, rooms: manager.rooms.size });
    const m = /^\/api\/rooms(?:\/([A-Za-z0-9]{8}))?(?:\/(join))?$/.exec(path);
    if (!m) return json(res, 404, { error: 'Not found.' });
    const code = m[1]?.toUpperCase();
    if (req.method === 'GET' && code && !m[2]) {
      const room = manager.get(code);
      if (!room) return json(res, 404, { error: 'No such room.' });
      const mine = room.seatByToken(cookies(req)[`cap_${code}`] ?? '');
      const v = room.publicView();
      return json(res, 200, { code, status: v.status, seats: v.seats.length, maxSeats: v.config.maxSeats, mySeat: mine?.seatId ?? null });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
    // State-changing endpoints: JSON only and an allowed Origin, so a foreign page cannot drive them.
    if (!originOk(req) || !(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 403, { error: 'Forbidden.' });
    let body: unknown;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'Invalid request.' }); }
    if (!code) {
      const parsed = createRoomSchema.safeParse(body);
      if (!parsed.success) return json(res, 400, { error: 'Invalid room settings.' });
      const ip = req.socket.remoteAddress ?? 'unknown';
      const recent = (creations.get(ip) ?? []).filter((t) => Date.now() - t < 3600_000);
      if (recent.length >= perHour) return json(res, 429, { error: 'Too many rooms created from this address. Try again later.' });
      creations.set(ip, [...recent, Date.now()]);
      const made = manager.create(parsed.data.config, parsed.data.name, parsed.data.color);
      return json(res, 201, { code: made.room.data.code, seatId: made.seatId }, { 'set-cookie': seatCookie(req, made.room.data.code, made.token) });
    }
    if (!isRoomCode(code)) return json(res, 404, { error: 'No such room.' });
    const room = manager.get(code);
    if (!room) return json(res, 404, { error: 'No such room.' });
    const existing = room.seatByToken(cookies(req)[`cap_${code}`] ?? '');
    if (existing) return json(res, 200, { code, seatId: existing.seatId, rejoined: true });
    const parsed = joinRoomSchema.safeParse(body);
    if (!parsed.success) return json(res, 400, { error: 'Enter a name to join.' });
    const seat = room.addHuman(parsed.data.name, parsed.data.color);
    if ('error' in seat) return json(res, 409, { error: seat.error });
    return json(res, 201, { code, seatId: seat.seatId }, { 'set-cookie': seatCookie(req, code, seat.token) });
  };

  const serveStatic = (req: IncomingMessage, res: ServerResponse, path: string): void => {
    const root = opts.staticDir;
    if (!root || !existsSync(root)) { res.writeHead(404).end('Not found'); return; }
    let file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(resolve(root))) { res.writeHead(403).end(); return; }
    if (!existsSync(file) || !statSync(file).isFile()) file = join(root, 'index.html'); // SPA fallback
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    createReadStream(file).pipe(res);
  };

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && opts.allowedOrigins.includes(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('access-control-allow-credentials', 'true');
        res.setHeader('access-control-allow-headers', 'content-type');
        res.setHeader('vary', 'origin');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      api(req, res, path).catch(() => json(res, 500, { error: 'Server error.' }));
    } else serveStatic(req, res, path);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const code = (url.searchParams.get('room') ?? '').toUpperCase();
    const room = url.pathname === '/ws' && isRoomCode(code) ? manager.get(code) : undefined;
    const seat = room?.seatByToken(cookies(req)[`cap_${code}`] ?? '');
    if (!room || !seat || !originOk(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      let alive = true;
      const conn: Conn = {
        send: (msg: ServerMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
        close: () => ws.close(4000, 'replaced'),
      };
      room.attach(seat.seatId, conn);
      const beat = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, 20_000);
      ws.on('pong', () => { alive = true; });
      ws.on('message', (raw) => {
        let data: unknown;
        try { data = JSON.parse(raw.toString()); } catch { return conn.send({ t: 'error', code: 'bad_message', message: 'Malformed message.' }); }
        const parsed = clientMessageSchema.safeParse(data);
        if (!parsed.success) return conn.send({ t: 'error', code: 'bad_message', message: 'Malformed message.' });
        try { room.handle(seat.seatId, conn, parsed.data); } catch (e) {
          console.error(`[room ${code}] handler error`, e instanceof Error ? e.message : 'unknown'); // never log payloads: they may hold private offers
          conn.send({ t: 'error', code: 'internal', message: 'Server error.' });
        }
      });
      ws.on('close', () => { clearInterval(beat); room.detach(seat.seatId, conn); });
      ws.on('error', () => ws.terminate());
    });
  });

  server.listen(opts.port);
  return {
    manager, repo, server,
    port: () => { const a = server.address(); return typeof a === 'object' && a ? a.port : opts.port; },
    close: () => new Promise<void>((done) => {
      manager.shutdown();
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close(() => { repo.close(); done(); });
      server.closeAllConnections();
    }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 8787);
  const here = fileURLToPath(new URL('.', import.meta.url));
  const srv = startServer({
    port, dbPath: process.env.DB_PATH ?? join(here, '../data/capital.sqlite'),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim()).filter(Boolean),
    staticDir: process.env.STATIC_DIR ?? join(here, '../../web/dist'),
  });
  console.log(`Capital server listening on :${port}`);
  const stop = () => { void srv.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
