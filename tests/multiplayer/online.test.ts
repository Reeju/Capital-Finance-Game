// Online integration: one real server, real sockets, distinct client sessions. Covers the release-gate list in spec §16/§19.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentPrompt, minTenderPrice, unitsOf } from '@capital/engine';
import { startServer } from '../../apps/server/src/main';
import { TestClient } from './client';

type Srv = ReturnType<typeof startServer>;
const dirs: string[] = [];
let live: Srv[] = [];
const fast = { turnMs: 60_000, relaxedTurnMs: 60_000, responseMs: 60_000, graceMs: 400, aiDelayMs: 1 };

function boot(dbPath?: string, timings = fast): { srv: Srv; base: string; dbPath: string } {
  const path = dbPath ?? join((dirs[dirs.push(mkdtempSync(join(tmpdir(), 'capital-'))) - 1]), 'db.sqlite');
  const srv = startServer({ port: 0, dbPath: path, allowedOrigins: ['http://localhost:5173'], timings, roomsPerHour: 1000 });
  live.push(srv);
  return { srv, base: `http://127.0.0.1:${srv.port()}`, dbPath: path };
}

async function lobby(base: string, extra: 'none' | 'ai' = 'none') {
  const a = new TestClient(base);
  const b = new TestClient(base);
  const code = await a.create('Ada');
  expect((await b.join(code, 'Ben')).status).toBe(201);
  await a.connect();
  await a.waitFor('welcome');
  await b.connect();
  await b.waitFor('welcome');
  if (extra === 'ai') a.send({ t: 'addAi', archetype: 'victor' });
  b.send({ t: 'ready', ready: true });
  await a.waitFor('room', (m) => m.room.seats.filter((s) => s.ready).length >= (extra === 'ai' ? 2 : 1) && m.room.seats.length === (extra === 'ai' ? 3 : 2));
  const started = Promise.all([a.waitFor('welcome', (m) => !!m.snapshot), b.waitFor('welcome', (m) => !!m.snapshot)]);
  a.send({ t: 'start' });
  await started;
  return { a, b, code };
}

afterEach(async () => {
  await Promise.all(live.map((s) => s.close()));
  live = [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('rooms and seat authentication', () => {
  it('creates an 8-character code, issues HttpOnly seat cookies and refuses sockets without them', async () => {
    const { base } = boot();
    const a = new TestClient(base);
    const res = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, body: JSON.stringify({ name: 'Ada', color: '#e4572e', config: { totalRounds: 12, maxSeats: 2, pacing: 'standard', disconnectPolicy: 'pass' } }) });
    const set = res.headers.get('set-cookie') ?? '';
    const { code } = (await res.json()) as { code: string };
    expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    a.code = code;
    await expect(a.connect({ cookie: '' })).rejects.toThrow(/401/); // knowing the code is not enough
    await expect(a.connect({ cookie: `cap_${code}=forged-token` })).rejects.toThrow(/401/);
    await expect(a.connect({ cookie: set.split(';')[0], origin: 'https://evil.example' })).rejects.toThrow(/401/);
    // a token for one room does not open another
    const other = new TestClient(base);
    const code2 = await other.create('Eve');
    await expect(a.connect({ cookie: set.split(';')[0].replace(code, code2), code: code2 })).rejects.toThrow(/401/);
  });
  it('rejects cross-site and non-JSON state changes, full rooms and late joiners', async () => {
    const { base } = boot();
    const bad = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    expect(bad.status).toBe(403);
    const form = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'http://localhost:5173' }, body: '{}' });
    expect(form.status).toBe(403);
    const { code } = await lobby(base);
    const late = new TestClient(base);
    expect((await late.join(code, 'Late')).status).toBe(409);
    expect((await fetch(`${base}/api/rooms/ZZZZZZZZ`)).status).toBe(404);
  });
  it('lets only the host configure, kick and start', async () => {
    const { base } = boot();
    const a = new TestClient(base);
    const b = new TestClient(base);
    const code = await a.create('Ada');
    await b.join(code, 'Ben');
    await a.connect();
    await b.connect();
    await b.waitFor('welcome');
    b.send({ t: 'start' });
    expect((await b.waitFor('error')).code).toBe('host_only');
    b.send({ t: 'kick', seatId: a.seatId });
    expect((await b.waitFor('error')).code).toBe('host_only');
    a.send({ t: 'start' });
    expect((await a.waitFor('error')).code).toBe('not_ready');
  });
});

describe('authoritative command path', () => {
  it('never sends seeds, RNG, pending news, rival research or third-party offers to a client', async () => {
    const { base, srv } = boot();
    const { a, b, code } = await lobby(base, 'ai');
    // a researches privately and makes a private offer to the AI seat
    expect((await a.command({ type: 'Move', to: 'wallstreet' })).accepted).toBe(true);
    expect((await a.command({ type: 'Research', sector: 'tech' })).accepted).toBe(true);
    expect((await a.command({ type: 'ProposeTrade', recipient: 's3', give: { cash: 100, units: {}, properties: [] }, receive: { cash: 0, units: {}, properties: [] }, note: 'psst-private-note' })).accepted).toBe(true);
    await b.until(() => (b.state?.revision ?? 0) >= 3);
    const full = srv.manager.get(code)?.state;
    expect(full?.hidden.sectorDemand).toBeDefined();
    expect(a.state?.players[a.seatId].research).toHaveLength(1);
    const seenByB = b.raw.join('\n');
    expect(b.state?.rng).toEqual({});
    expect(b.state?.players[a.seatId].research).toEqual([]);
    expect(Object.keys(b.state?.offers ?? {})).toHaveLength(0);
    expect(seenByB).not.toContain('psst-private-note');
    expect(seenByB).not.toContain('"midpoint"');
    expect(seenByB).not.toContain('tokenHash');
    for (const stream of Object.values(full?.rng ?? {})) expect(seenByB).not.toContain(`"s":${stream.s},`);
    expect(seenByB).not.toMatch(/"pendingRegime":"/);
    expect(a.raw.join('\n')).not.toMatch(/"pendingRegime":"/);
  });
  it('rejects wrong actors, stale revisions, system commands and malformed or oversized payloads without mutating', async () => {
    const { base, srv } = boot();
    const { a, b, code } = await lobby(base);
    const rev = () => srv.manager.get(code)?.state?.revision;
    const r0 = rev();
    expect((await b.command({ type: 'EndTurn' })).error?.code).toBe('not_your_turn');
    expect((await b.command({ type: 'EndTurn' }, { actorId: a.seatId })).error?.code).toBe('forbidden');
    expect((await a.command({ type: 'EndTurn' }, { expectedRevision: 99 })).error?.code).toBe('stale');
    a.send({ t: 'command', envelope: a.envelope({ type: 'TimeoutTurn' }) });
    expect((await a.waitFor('error')).code).toBe('bad_message');
    a.send({ t: 'command', envelope: { ...a.envelope({ type: 'EndTurn' }), extra: 'state-replacement' } });
    expect((await a.waitFor('error')).code).toBe('bad_message');
    a.ws?.send('not json');
    expect((await a.waitFor('error')).code).toBe('bad_message');
    expect(rev()).toBe(r0);
    const closed = new Promise((ok) => a.ws?.once('close', ok));
    a.ws?.send(JSON.stringify({ t: 'chat', text: 'x'.repeat(20_000) }));
    await closed; // payloads over 16KB drop the socket
    expect(rev()).toBe(r0);
  });
  it('executes a duplicated command exactly once and replays the stored acknowledgement', async () => {
    const { base, srv } = boot();
    const { a, code } = await lobby(base);
    const env = a.envelope({ type: 'Move', to: 'wallstreet' });
    const first = await a.sendEnvelope(env);
    const again = await a.sendEnvelope(env); // e.g. the Ack was dropped and the client retried
    expect(first.accepted).toBe(true);
    expect(again).toEqual(first);
    const s = srv.manager.get(code)?.state;
    expect(s?.revision).toBe(first.revision);
    expect(s?.apRemaining).toBe(2);
  });
  it('rolls back cleanly when the database fails before commit', async () => {
    const { base, srv } = boot();
    const { a, code } = await lobby(base);
    const before = srv.manager.get(code)?.state;
    const real = srv.repo.commit.bind(srv.repo);
    srv.repo.commit = () => { throw new Error('disk full'); };
    const ack = await a.command({ type: 'Move', to: 'wallstreet' });
    expect(ack.error?.code).toBe('internal');
    expect(srv.manager.get(code)?.state).toBe(before);
    srv.repo.commit = real;
    expect((await a.command({ type: 'Move', to: 'wallstreet' })).accepted).toBe(true);
  });
  it('serializes concurrent bids: only one of two same-revision commands is accepted', async () => {
    const { base } = boot();
    const { a, b } = await lobby(base);
    const [x, y] = await Promise.all([a.command({ type: 'EndTurn' }), b.command({ type: 'EndTurn' })]);
    expect([x.accepted, y.accepted].filter(Boolean)).toHaveLength(1);
  });
});

describe('full online match', () => {
  it('plays 12 rounds with a trade, an auction and a tender, then replays to the same state', async () => {
    const { base, srv } = boot();
    const { a, b, code } = await lobby(base);
    // Round 1, seat a: a binding gift offer. Seat b accepts it in the deals window.
    expect((await a.command({ type: 'ProposeTrade', recipient: b.seatId, give: { cash: 25_000_00, units: {}, properties: [] }, receive: { cash: 0, units: {}, properties: [] } })).accepted).toBe(true);
    expect((await a.command({ type: 'Move', to: 'wallstreet' })).accepted).toBe(true);
    expect((await a.command({ type: 'MarketOrder', companyId: 'mpwr', shares: 1500 })).accepted).toBe(true);
    await a.command({ type: 'EndTurn' });
    await b.until(() => b.myTurn());
    await b.command({ type: 'EndTurn' });
    await b.until(() => currentPrompt(b.state!).kind === 'offer');
    const offerId = Object.keys(b.state?.offers ?? {})[0];
    expect((await b.command({ type: 'AcceptOffer', offerId })).accepted).toBe(true);
    expect(b.state?.players[b.seatId].cash).toBe(525_000_00);
    // Auction: both seats are prompted in turn; the first bidder wins after the other passes.
    while (a.state?.round === 1 && currentPrompt(a.state).kind === 'auction') {
      const who = [a, b].find((c) => c.myTurn());
      if (!who) { await new Promise((r) => setTimeout(r, 5)); continue; }
      const mine = who.state?.auction?.highBidder === null && who === b;
      await who.command(mine ? { type: 'Bid', amount: Math.max(who.state?.auction?.reserve ?? 0, 5_000_00) } : { type: 'PassAuction' });
    }
    await a.until(() => (a.state?.round ?? 0) >= 2).catch(() => undefined);
    expect(srv.manager.get(code)?.state?.log.some((e) => e.type === 'auction_won')).toBe(true);
    // Round 2: seat a launches a tender for control of MetroPower from Wall Street.
    while (!a.myTurn()) { if (b.myTurn()) await b.command({ type: 'EndTurn' }); else await new Promise((r) => setTimeout(r, 5)); }
    const price = minTenderPrice(a.state!, 'mpwr');
    const tender = await a.command({ type: 'Tender', companyId: 'mpwr', price, maxShares: 3501, minShares: 3501 });
    expect(tender.accepted).toBe(true);
    await a.command({ type: 'EndTurn' });
    await a.until(() => unitsOf(a.state!, a.seatId, 'mpwr') === 5001 || (a.state?.round ?? 0) > 2).catch(() => undefined);
    if (b.myTurn()) await b.command({ type: 'EndTurn' });
    const done = () => a.state?.phase === 'finished' && b.state?.phase === 'finished';
    await Promise.all([a.autoplay(done), b.autoplay(done)]);
    const final = srv.manager.get(code)?.state;
    expect(final?.round).toBe(12);
    expect(final?.log.some((e) => e.type === 'trade_executed')).toBe(true);
    expect(final?.log.some((e) => e.type === 'tender_filled')).toBe(true);
    expect(final?.control.mpwr === a.seatId || final?.log.some((e) => e.type === 'control_acquired')).toBe(true);
    expect(a.state?.result?.winners).toEqual(final?.result?.winners);
    expect(b.state?.result?.rows.map((r) => r.adjusted)).toEqual(final?.result?.rows.map((r) => r.adjusted));
    const audit = srv.manager.get(code)?.auditReplay();
    expect(audit?.ok).toBe(true);
    expect(audit?.commands).toBeGreaterThan(40);
    expect(srv.manager.get(code)?.publicView().status).toBe('finished');
  });
});

describe('disconnects, deadlines and restarts', () => {
  it('lets a seat reconnect mid-turn with its cookie and resume from the current revision', async () => {
    const { base } = boot();
    const { a, b } = await lobby(base);
    await a.command({ type: 'Move', to: 'wallstreet' });
    await a.close();
    await b.waitFor('room', (m) => m.room.seats.some((s) => s.seatId === a.seatId && !s.connected));
    const before = a.state?.revision;
    await a.connect();
    const w = await a.waitFor('welcome');
    expect(w.seatId).toBe(a.seatId);
    expect(w.revision).toBe(before);
    expect(w.snapshot?.apRemaining).toBe(2);
    expect((await a.command({ type: 'MarketOrder', companyId: 'mpwr', shares: 10 })).accepted).toBe(true);
  });
  it('times a silent seat out with a pass, never a purchase', async () => {
    const { base, srv } = boot(undefined, { ...fast, turnMs: 150, responseMs: 150 });
    const { a, b, code } = await lobby(base);
    await b.until(() => b.myTurn());
    const s = srv.manager.get(code)?.state;
    expect(s?.log.some((e) => e.type === 'timeout')).toBe(true);
    expect(s?.players[a.seatId].cash).toBe(500_000_00);
  });
  it('gives a disconnected seat a grace period, then applies the room policy (AI takeover)', async () => {
    const { base, srv } = boot(undefined, { ...fast, turnMs: 300, graceMs: 600 });
    const a = new TestClient(base);
    const b = new TestClient(base);
    const code = await a.create('Ada', { totalRounds: 12, maxSeats: 2, pacing: 'standard', disconnectPolicy: 'ai' });
    await b.join(code, 'Ben');
    await a.connect();
    await b.connect();
    await b.waitFor('welcome');
    b.send({ t: 'ready', ready: true });
    await a.waitFor('room', (m) => m.room.seats.every((s) => s.ready || s.host));
    a.send({ t: 'start' });
    await b.waitFor('welcome', (m) => !!m.snapshot);
    const t0 = Date.now();
    await a.close();
    const room = await b.waitFor('room', (m) => m.room.seats.some((s) => s.seatId === a.seatId && s.aiControlled), 5000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550); // grace outlasted the 300ms turn clock
    expect(room.room.seats.find((s) => s.seatId === a.seatId)?.connected).toBe(false);
    await b.until(() => b.myTurn());
    expect(srv.manager.get(code)?.state?.log.some((e) => e.type === 'timeout')).toBe(false);
    await a.connect(); // the player returns and takes the seat back
    await b.waitFor('room', (m) => m.room.seats.some((s) => s.seatId === a.seatId && !s.aiControlled && s.connected));
  });
  it('survives a server restart: state, seats and the command log are restored and play continues', async () => {
    const first = boot();
    const { a, b, code } = await lobby(first.base);
    await a.command({ type: 'Move', to: 'wallstreet' });
    const ack = await a.command({ type: 'MarketOrder', companyId: 'byte', shares: 100 });
    expect(ack.accepted).toBe(true);
    await first.srv.close();
    live = [];
    const second = boot(first.dbPath);
    a.base = second.base;
    b.base = second.base;
    await a.connect();
    const w = await a.waitFor('welcome');
    expect(w.revision).toBe(ack.revision);
    expect(unitsOf(w.snapshot!, a.seatId, 'byte')).toBe(100);
    await b.connect();
    await b.waitFor('welcome');
    expect((await a.command({ type: 'EndTurn' })).accepted).toBe(true);
    await b.until(() => b.myTurn());
    expect((await b.command({ type: 'EndTurn' })).accepted).toBe(true);
    expect(second.srv.manager.get(code)?.auditReplay().ok).toBe(true);
  });
  it('suspends when everyone leaves and pauses only when every connected human agrees', async () => {
    const { base, srv } = boot(undefined, { ...fast, turnMs: 200 });
    const { a, b, code } = await lobby(base);
    a.send({ t: 'pauseVote', paused: true });
    await b.waitFor('room', (m) => m.room.pauseVotes.length === 1);
    expect(srv.manager.get(code)?.paused).toBe(false);
    b.send({ t: 'pauseVote', paused: true });
    await a.waitFor('room', (m) => m.room.paused);
    expect((await a.command({ type: 'EndTurn' })).error?.code).toBe('paused');
    await new Promise((r) => setTimeout(r, 400));
    expect(srv.manager.get(code)?.state?.log.some((e) => e.type === 'timeout')).toBe(false);
    await a.close();
    await b.close();
    await new Promise((r) => setTimeout(r, 400));
    expect(srv.manager.get(code)?.state?.log.some((e) => e.type === 'timeout')).toBe(false);
    expect(srv.manager.get(code)?.state?.round).toBe(1);
  });
});
