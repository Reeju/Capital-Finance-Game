// Mutation context, ledger primitives and ownership selectors. All cash moves go through pay().
import { MAX_TOTAL, reject } from './money';
import type { GameEvent, HolderId, MatchState, Money, Pledge, SeatId } from './types';

export interface Ctx { s: MatchState; events: GameEvent[]; dry: boolean }

export const RULES_VERSION = 'capital-1.1.0';
export const SCHEMA_VERSION = 1;
export const AP_PER_TURN = 3;

export function emit(ctx: Ctx, type: string, text: string, extra: Partial<GameEvent> = {}): void {
  const ev: GameEvent = { type, round: ctx.s.round, text, ...extra };
  ctx.events.push(ev);
  ctx.s.log.push(ev);
}

export function newId(ctx: Ctx, prefix: string): string {
  return `${prefix}${ctx.s.nextId++}`;
}

export const acct = { player: (id: SeatId) => `player:${id}`, company: (id: string) => `company:${id}`, holder: (h: HolderId) => (h === 'bank' ? 'bank' : `player:${h}`) };

function bump(s: MatchState, account: string, delta: Money): void {
  if (account === 'bank') s.bankCash += delta;
  else if (account === 'economy') s.economyCash += delta;
  else if (account.startsWith('player:')) {
    const p = s.players[account.slice(7)];
    if (!p) throw new Error(`unknown account ${account}`);
    p.cash += delta;
    if (p.cash < 0) throw new Error(`invariant: negative cash for ${account}`);
    if (p.cash > MAX_TOTAL) reject('limit', 'Cash would exceed the engine limit.');
  } else if (account.startsWith('company:')) {
    const c = s.companies[account.slice(8)];
    if (!c) throw new Error(`unknown account ${account}`);
    c.cash += delta;
    if (c.cash < 0) throw new Error(`invariant: negative cash for ${account}`);
  } else throw new Error(`unknown account ${account}`);
}

/** Balanced two-line journal entry moving cash between accounts. Bank and economy may go negative (modelled sources). */
export function pay(ctx: Ctx, from: string, to: string, amount: Money, memo: string): void {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`invariant: bad payment ${amount} (${memo})`);
  if (amount === 0 || from === to) return;
  const s = ctx.s;
  bump(s, from, -amount);
  bump(s, to, amount);
  s.journal.push({ id: s.journal.length + 1, round: s.round, revision: s.revision, memo, lines: [{ account: from, delta: -amount }, { account: to, delta: amount }] });
  if (to.startsWith('player:')) trackMinCash(s, to.slice(7));
  if (from.startsWith('player:')) trackMinCash(s, from.slice(7));
}

export function trackMinCash(s: MatchState, seat: SeatId): void {
  const p = s.players[seat];
  const sp = Math.max(0, spendable(s, seat));
  if (sp < p.minCash) p.minCash = sp;
}

// ---------- ownership ----------
export function unitsOf(s: MatchState, holder: HolderId, companyId: string): number {
  return s.ownership.units[companyId]?.[holder] ?? 0;
}

export function moveUnits(ctx: Ctx, companyId: string, from: HolderId, to: HolderId, units: number): void {
  if (units === 0 || from === to) return;
  const book = ctx.s.ownership.units[companyId];
  if (!book || !Number.isSafeInteger(units) || units < 0 || (book[from] ?? 0) < units) throw new Error('invariant: bad unit transfer');
  book[from] -= units;
  if (book[from] === 0 && from !== 'bank') delete book[from];
  book[to] = (book[to] ?? 0) + units;
  recomputeControl(ctx, companyId);
}

export function moveTitle(ctx: Ctx, propertyId: string, from: HolderId, to: HolderId): void {
  if (ctx.s.ownership.titles[propertyId] !== from) throw new Error('invariant: bad title transfer');
  ctx.s.ownership.titles[propertyId] = to;
  for (const syn of ctx.s.content.synergies) if (syn.propertyId === propertyId) for (const c of syn.companyIds) recomputeControl(ctx, c);
}

export function controllerOf(s: MatchState, companyId: string): SeatId | null {
  const book = s.ownership.units[companyId] ?? {};
  const total = defOf(s, companyId).sharesOutstanding;
  for (const seat of s.seatOrder) if ((book[seat] ?? 0) * 2 > total) return seat;
  return null;
}

export function recomputeControl(ctx: Ctx, companyId: string): void {
  const s = ctx.s;
  const prev = s.control[companyId] ?? null;
  const now = controllerOf(s, companyId);
  if (prev === now) return;
  s.control[companyId] = now;
  const name = defOf(s, companyId).name;
  if (prev) emit(ctx, 'control_lost', `${s.players[prev].name} lost control of ${name}.`, { seat: prev, data: { companyId } });
  if (now) emit(ctx, 'control_acquired', `${s.players[now].name} now controls ${name}.`, { seat: now, data: { companyId } });
}

export function defOf(s: MatchState, companyId: string) {
  const d = s.content.companies.find((c) => c.id === companyId);
  if (!d) reject('unknown_company', 'Unknown company.');
  return d;
}

export function propDefOf(s: MatchState, propertyId: string) {
  const d = s.content.properties.find((c) => c.id === propertyId);
  if (!d) reject('unknown_property', 'Unknown property.');
  return d;
}

export function activeLoans(s: MatchState) {
  return Object.values(s.loans).filter((l) => l.status !== 'paid');
}

export function pledgedUnits(s: MatchState, seat: SeatId, companyId: string): number {
  let n = 0;
  for (const l of activeLoans(s)) if (l.borrower === seat) for (const c of l.collateral) if (c.kind === 'units' && c.companyId === companyId) n += c.units;
  return n;
}

export function reservedUnits(s: MatchState, seat: SeatId, companyId: string): number {
  let n = 0;
  for (const o of Object.values(s.offers)) if (o.status === 'open' && o.proposer === seat) n += o.give.units[companyId] ?? 0;
  let locked = 0;
  for (const c of s.contracts) if (c.seller === seat && c.companyId === companyId) locked = Math.max(locked, c.units);
  n += locked;
  for (const l of s.listings) if (l.seller === seat && l.asset.kind === 'units' && l.asset.companyId === companyId) n += l.asset.units;
  const a = s.auction;
  if (a && a.seller === seat && a.asset.kind === 'units' && a.asset.companyId === companyId) n += a.asset.units;
  if (s.tender && s.tender.companyId === companyId) n += s.tender.responses[seat] ?? 0;
  return n;
}

export function availableUnits(s: MatchState, seat: SeatId, companyId: string): number {
  return unitsOf(s, seat, companyId) - pledgedUnits(s, seat, companyId) - reservedUnits(s, seat, companyId);
}

export function propertyPledged(s: MatchState, propertyId: string): boolean {
  return activeLoans(s).some((l) => l.collateral.some((c) => c.kind === 'property' && c.propertyId === propertyId));
}

export function propertyReserved(s: MatchState, propertyId: string): boolean {
  if (Object.values(s.offers).some((o) => o.status === 'open' && o.give.properties.includes(propertyId))) return true;
  if (s.listings.some((l) => l.asset.kind === 'property' && l.asset.propertyId === propertyId)) return true;
  const a = s.auction;
  return !!a && a.asset.kind === 'property' && a.asset.propertyId === propertyId;
}

export function reservedCash(s: MatchState, seat: SeatId): Money {
  let n = 0;
  for (const o of Object.values(s.offers)) {
    if (o.status !== 'open' || o.proposer !== seat) continue;
    n += o.give.cash;
    if (o.terms.kind === 'loan' && o.terms.lender === seat) n += o.terms.principal;
    if (o.terms.kind === 'rights' && o.terms.buyer === seat) n += o.terms.price;
  }
  if (s.auction && s.auction.highBidder === seat) n += s.auction.highBid;
  if (s.tender && s.tender.bidder === seat) n += s.tender.price * s.tender.maxShares;
  return n;
}

export function spendable(s: MatchState, seat: SeatId): Money {
  return s.players[seat].cash - reservedCash(s, seat);
}

export function pledgeKey(p: Pledge): string {
  return p.kind === 'units' ? `u:${p.companyId}` : `p:${p.propertyId}`;
}

export function addRep(ctx: Ctx, seat: SeatId, delta: number): void {
  const p = ctx.s.players[seat];
  p.reputation = Math.max(0, Math.min(100, p.reputation + delta));
}

export function position(s: MatchState, seat: SeatId, assetId: string) {
  const p = s.players[seat];
  return (p.positions[assetId] ??= { spent: 0, received: 0, income: 0 });
}

export function count(s: MatchState, seat: SeatId, key: string): void {
  const p = s.players[seat];
  p.actionCounts[key] = (p.actionCounts[key] ?? 0) + 1;
}

export function seatsSorted(s: MatchState): SeatId[] {
  return [...s.seatOrder].sort();
}
