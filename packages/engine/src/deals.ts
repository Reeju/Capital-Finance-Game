// Player-to-player offers (spot trades, loans, dividend rights), the round auction and tender offers.
import {
  type Ctx, acct, addRep, availableUnits, count, defOf, emit, moveTitle, moveUnits, newId, pay, pledgedUnits, position, propDefOf,
  propertyPledged, propertyReserved, spendable, unitsOf,
} from './core';
import { payLoan, validatePlayerLoanTerms, validatePledges } from './loans';
import { loansSecuredOn } from './market';
import { assertInt, assertMoney, distribute, fmtUsd, mulDivFloor, reject } from './money';
import { holdersOf, propertyValue, unitValue, valueCompany } from './valuation';
import type { AssetBundle, AuctionAsset, Bps, Loan, MatchState, Money, Pledge, SeatId, TradeOffer } from './types';

export const MIN_INCREMENT: Money = 5_000_00;
export const MAX_OPEN_PROPOSALS = 2;
export const MAX_PROPOSALS_PER_ROUND = 8;

export function emptyBundle(): AssetBundle {
  return { cash: 0, units: {}, properties: [] };
}

function normalizeBundle(s: MatchState, b: AssetBundle): AssetBundle {
  if (!b || typeof b !== 'object' || typeof b.units !== 'object' || b.units === null || !Array.isArray(b.properties)) reject('bad_bundle', 'Invalid offer contents.');
  assertMoney(b.cash, 'Cash');
  const units: Record<string, number> = {};
  for (const id of Object.keys(b.units).sort()) {
    const def = defOf(s, id);
    assertInt(b.units[id], 'Units', 0, def.sharesOutstanding);
    if (b.units[id] > 0) units[id] = b.units[id];
  }
  const properties = [...new Set(b.properties)].sort();
  for (const id of properties) propDefOf(s, id);
  return { cash: b.cash, units, properties };
}

function bundleEmpty(b: AssetBundle): boolean {
  return b.cash === 0 && Object.keys(b.units).length === 0 && b.properties.length === 0;
}

/** Loans that must be paid off to release pledged assets inside `bundle`. Rejects if the giver cannot deliver. */
function deliverable(s: MatchState, giver: SeatId, bundle: AssetBundle, incomingCash: Money): Loan[] {
  if (spendable(s, giver) < bundle.cash) reject('insufficient_cash', `${s.players[giver].name} does not have ${fmtUsd(bundle.cash)} in spendable cash.`);
  const release = new Map<string, Loan>();
  for (const [companyId, n] of Object.entries(bundle.units)) {
    const owned = unitsOf(s, giver, companyId);
    const free = availableUnits(s, giver, companyId);
    if (owned < n) reject('not_owned', `${s.players[giver].name} does not own ${n} units of ${defOf(s, companyId).name}.`);
    if (free < n) {
      if (free + pledgedUnits(s, giver, companyId) < n) reject('reserved', 'Some of those units are reserved by another offer or contract.');
      for (const l of loansSecuredOn(s, giver, { companyId })) release.set(l.id, l);
    }
  }
  for (const propertyId of bundle.properties) {
    if (s.ownership.titles[propertyId] !== giver) reject('not_owned', `${s.players[giver].name} does not own ${propDefOf(s, propertyId).name}.`);
    if (propertyReserved(s, propertyId)) reject('reserved', 'That property is reserved by another offer or listing.');
    if (propertyPledged(s, propertyId)) for (const l of loansSecuredOn(s, giver, { propertyId })) release.set(l.id, l);
  }
  const loans = [...release.values()];
  const payoff = loans.reduce((a, l) => a + l.principal + l.arrears, 0);
  if (payoff > incomingCash) reject('encumbered', `Pledged assets in this deal secure ${fmtUsd(payoff)} of debt; the cash received must cover that to release them.`);
  return loans;
}

function checkProposalLimits(s: MatchState, seat: SeatId, recipient: SeatId): void {
  if (!s.players[recipient] || recipient === seat) reject('bad_recipient', 'Choose another player.');
  const open = Object.values(s.offers).filter((o) => o.status === 'open' && o.proposer === seat).length;
  if (open >= MAX_OPEN_PROPOSALS) reject('too_many_open', 'You can have at most two open proposals.');
  if (s.players[seat].proposalsThisRound >= MAX_PROPOSALS_PER_ROUND) reject('proposal_limit', 'You have reached this year\'s limit of eight proposals and withdrawals.');
}

function addOffer(ctx: Ctx, o: Omit<TradeOffer, 'id' | 'revision' | 'expiryRound' | 'status'>): TradeOffer {
  const s = ctx.s;
  const id = newId(ctx, 'O');
  const offer: TradeOffer = { ...o, id, revision: s.revision, expiryRound: s.round, status: 'open' };
  s.offers[id] = offer;
  s.players[o.proposer].proposalsThisRound += 1;
  count(s, o.proposer, 'propose');
  emit(ctx, 'offer_proposed', `${s.players[o.proposer].name} sent ${s.players[o.recipient].name} a binding proposal.`, { seat: o.proposer, visibleTo: [o.proposer, o.recipient], data: { offerId: id } });
  return offer;
}

export function proposeTrade(ctx: Ctx, seat: SeatId, recipient: SeatId, giveIn: AssetBundle, receiveIn: AssetBundle, note?: string): void {
  const s = ctx.s;
  checkProposalLimits(s, seat, recipient);
  const give = normalizeBundle(s, giveIn);
  const receive = normalizeBundle(s, receiveIn);
  if (bundleEmpty(give) && bundleEmpty(receive)) reject('empty', 'An offer needs something in it.');
  if (note !== undefined && (typeof note !== 'string' || note.length > 300)) reject('bad_note', 'Notes are limited to 300 characters.');
  deliverable(s, seat, give, receive.cash);
  addOffer(ctx, { proposer: seat, recipient, give, receive, terms: { kind: 'trade' }, note });
}

export function proposeLoan(ctx: Ctx, seat: SeatId, recipient: SeatId, role: 'lender' | 'borrower', principal: Money, rate: Bps, term: number, collateral: Pledge[]): void {
  const s = ctx.s;
  checkProposalLimits(s, seat, recipient);
  validatePlayerLoanTerms(principal, rate, term);
  if (role !== 'lender' && role !== 'borrower') reject('bad_role', 'Choose lender or borrower.');
  const lender = role === 'lender' ? seat : recipient;
  const borrower = role === 'lender' ? recipient : seat;
  if (!Array.isArray(collateral)) reject('bad_collateral', 'Invalid collateral.');
  if (lender === seat && spendable(s, seat) < principal) reject('insufficient_cash', 'You do not have that much spendable cash to lend.');
  if (borrower === seat) {
    const err = validatePledges(s, seat, collateral);
    if (err) reject('bad_collateral', err);
  }
  addOffer(ctx, { proposer: seat, recipient, give: emptyBundle(), receive: emptyBundle(), terms: { kind: 'loan', lender, borrower, principal, rate, term, collateral: collateral.map((c) => ({ ...c })) } });
}

export function assignedRightsBps(s: MatchState, seller: SeatId, companyId: string): Bps {
  return s.contracts.filter((c) => c.seller === seller && c.companyId === companyId).reduce((a, c) => a + c.bps, 0);
}

export function proposeRights(ctx: Ctx, seat: SeatId, recipient: SeatId, role: 'buyer' | 'seller', companyId: string, bps: Bps, rounds: number, price: Money): void {
  const s = ctx.s;
  checkProposalLimits(s, seat, recipient);
  defOf(s, companyId);
  assertInt(bps, 'Share of dividends', 1, 10_000);
  assertInt(rounds, 'Duration', 1, 3);
  assertMoney(price, 'Price', false);
  if (role !== 'buyer' && role !== 'seller') reject('bad_role', 'Choose buyer or seller.');
  const buyer = role === 'buyer' ? seat : recipient;
  const seller = role === 'buyer' ? recipient : seat;
  if (buyer === seat && spendable(s, seat) < price) reject('insufficient_cash', 'You do not have that much spendable cash.');
  if (unitsOf(s, seller, companyId) <= 0) reject('not_owned', `${s.players[seller].name} owns no stake in that company.`);
  if (assignedRightsBps(s, seller, companyId) + bps > 10_000) reject('over_assigned', 'More than 100% of those dividends would be assigned.');
  addOffer(ctx, { proposer: seat, recipient, give: emptyBundle(), receive: emptyBundle(), terms: { kind: 'rights', buyer, seller, companyId, bps, rounds, price } });
}

function creditContractRep(ctx: Ctx, seats: SeatId[]): void {
  for (const seat of seats) {
    const p = ctx.s.players[seat];
    if (p.repContractRound === ctx.s.round || p.repFromContracts >= 3) continue;
    p.repContractRound = ctx.s.round;
    p.repFromContracts += 1;
    addRep(ctx, seat, 1);
  }
}

/** Recheck both sides against current state, then settle everything atomically (any failure rejects the command). */
export function acceptOffer(ctx: Ctx, seat: SeatId, offerId: string): void {
  const s = ctx.s;
  const o = s.offers[offerId];
  if (!o || o.status !== 'open' || o.recipient !== seat) reject('unknown_offer', 'That offer is not open to you.');
  o.status = 'accepted'; // drops the proposer's reservation so the rechecks below see real inventory
  const a = s.players[o.proposer];
  const b = s.players[o.recipient];
  if (o.terms.kind === 'trade') {
    const relA = deliverable(s, o.proposer, o.give, o.receive.cash);
    const relB = deliverable(s, o.recipient, o.receive, o.give.cash);
    pay(ctx, acct.player(a.id), acct.player(b.id), o.give.cash, `trade ${o.id}`);
    pay(ctx, acct.player(b.id), acct.player(a.id), o.receive.cash, `trade ${o.id}`);
    for (const l of relA) payLoan(ctx, l, l.principal + l.arrears, 'release');
    for (const l of relB) payLoan(ctx, l, l.principal + l.arrears, 'release');
    for (const [companyId, n] of Object.entries(o.give.units)) moveUnits(ctx, companyId, a.id, b.id, n);
    for (const [companyId, n] of Object.entries(o.receive.units)) moveUnits(ctx, companyId, b.id, a.id, n);
    for (const id of o.give.properties) moveTitle(ctx, id, a.id, b.id);
    for (const id of o.receive.properties) moveTitle(ctx, id, b.id, a.id);
    emit(ctx, 'trade_executed', `${a.name} and ${b.name} traded: ${describeBundle(s, o.give)} for ${describeBundle(s, o.receive)}.`, { data: { offerId } });
  } else if (o.terms.kind === 'loan') {
    const t = o.terms;
    if (spendable(s, t.lender) < t.principal) reject('insufficient_cash', `${s.players[t.lender].name} no longer has the cash to lend.`);
    const err = validatePledges(s, t.borrower, t.collateral);
    if (err) reject('bad_collateral', err);
    const id = newId(ctx, 'L');
    s.loans[id] = {
      id, lender: t.lender, borrower: t.borrower, principal: t.principal, rate: t.rate, rateType: 'fixed', spread: 0, originatedRound: s.round,
      maturityRound: s.round + t.term, annualPrincipal: Math.ceil(t.principal / t.term), accruedInterest: 0, arrears: 0,
      collateral: t.collateral.map((c) => ({ ...c })), status: 'current',
    };
    pay(ctx, acct.player(t.lender), acct.player(t.borrower), t.principal, `player loan ${id}`);
    creditContractRep(ctx, [t.lender, t.borrower]);
    emit(ctx, 'player_loan', `${s.players[t.lender].name} lent ${s.players[t.borrower].name} ${fmtUsd(t.principal)} at ${(t.rate / 100).toFixed(1)}% for ${t.term} year${t.term > 1 ? 's' : ''}.`, { data: { loanId: id } });
  } else {
    const t = o.terms;
    if (spendable(s, t.buyer) < t.price) reject('insufficient_cash', `${s.players[t.buyer].name} no longer has the cash.`);
    const units = unitsOf(s, t.seller, t.companyId);
    if (units <= 0) reject('not_owned', `${s.players[t.seller].name} no longer owns a stake.`);
    if (assignedRightsBps(s, t.seller, t.companyId) + t.bps > 10_000) reject('over_assigned', 'More than 100% of those dividends would be assigned.');
    const def = defOf(s, t.companyId);
    const expected = mulDivFloor(mulDivFloor(s.companies[t.companyId].lastDividend, units, def.sharesOutstanding), t.bps, 10_000);
    s.contracts.push({ id: newId(ctx, 'C'), kind: 'rights', buyer: t.buyer, seller: t.seller, companyId: t.companyId, bps: t.bps, roundsLeft: t.rounds, units, trailing: expected });
    pay(ctx, acct.player(t.buyer), acct.player(t.seller), t.price, `dividend rights ${o.id}`);
    creditContractRep(ctx, [t.buyer, t.seller]);
    emit(ctx, 'rights_sold', `${s.players[t.buyer].name} bought ${t.bps / 100}% of ${s.players[t.seller].name}'s ${def.name} dividends for ${t.rounds} year${t.rounds > 1 ? 's' : ''} at ${fmtUsd(t.price)}.`, { data: { offerId } });
  }
  count(s, o.proposer, 'dealDone');
  count(s, o.recipient, 'dealDone');
}

export function rejectOffer(ctx: Ctx, seat: SeatId, offerId: string): void {
  const o = ctx.s.offers[offerId];
  if (!o || o.status !== 'open' || o.recipient !== seat) reject('unknown_offer', 'That offer is not open to you.');
  o.status = 'rejected';
  emit(ctx, 'offer_rejected', `${ctx.s.players[seat].name} declined ${ctx.s.players[o.proposer].name}'s proposal.`, { visibleTo: [o.proposer, o.recipient], data: { offerId } });
}

export function withdrawOffer(ctx: Ctx, seat: SeatId, offerId: string): void {
  const s = ctx.s;
  const o = s.offers[offerId];
  if (!o || o.status !== 'open' || o.proposer !== seat) reject('unknown_offer', 'That is not one of your open offers.');
  if (s.players[seat].proposalsThisRound >= MAX_PROPOSALS_PER_ROUND) reject('proposal_limit', 'You have reached this year\'s limit of eight proposals and withdrawals.');
  o.status = 'withdrawn';
  s.players[seat].proposalsThisRound += 1;
  emit(ctx, 'offer_withdrawn', `${s.players[seat].name} withdrew a proposal.`, { visibleTo: [o.proposer, o.recipient], data: { offerId } });
}

export function describeBundle(s: MatchState, b: AssetBundle): string {
  const parts: string[] = [];
  if (b.cash > 0) parts.push(fmtUsd(b.cash));
  for (const [id, n] of Object.entries(b.units)) {
    const d = defOf(s, id);
    parts.push(d.kind === 'public' ? `${n} ${d.ticker}` : `${(n / 100).toFixed(n % 100 ? 2 : 0)}% of ${d.name}`);
  }
  for (const id of b.properties) parts.push(propDefOf(s, id).name);
  return parts.length ? parts.join(' + ') : 'nothing';
}

// ---------- auction ----------
export function auctionAssetValue(s: MatchState, a: AuctionAsset): Money {
  return a.kind === 'property' ? propertyValue(s, a.propertyId) : unitValue(s, a.companyId, a.units);
}

export function auctionAssetName(s: MatchState, a: AuctionAsset): string {
  if (a.kind === 'property') return propDefOf(s, a.propertyId).name;
  const d = defOf(s, a.companyId);
  return a.units === d.sharesOutstanding ? d.name : `${a.units} units of ${d.name}`;
}

/** Open: reveal one lot. A queued player listing goes first (FIFO); otherwise the next bank-owned asset in rotation. */
export function revealAuction(ctx: Ctx): void {
  const s = ctx.s;
  s.auction = null;
  const order = [...s.seatOrder.slice(s.startIndex), ...s.seatOrder.slice(0, s.startIndex)];
  while (s.listings.length > 0) {
    const l = s.listings.shift();
    if (!l) break;
    const stillOwned = l.asset.kind === 'property'
      ? s.ownership.titles[l.asset.propertyId] === l.seller && !propertyPledged(s, l.asset.propertyId)
      : availableUnits(s, l.seller, l.asset.companyId) >= l.asset.units;
    if (!stillOwned) continue;
    s.auction = { id: newId(ctx, 'A'), asset: l.asset, seller: l.seller, reserve: l.reserve, highBid: 0, highBidder: null, passed: [], order: order.filter((x) => x !== l.seller), next: 0 };
    break;
  }
  if (!s.auction) {
    const pool: AuctionAsset[] = [
      ...s.content.properties.map((p): AuctionAsset => ({ kind: 'property', propertyId: p.id })),
      ...s.content.companies.filter((c) => c.kind === 'private').map((c): AuctionAsset => ({ kind: 'units', companyId: c.id, units: c.sharesOutstanding })),
    ];
    for (let i = 0; i < pool.length; i++) {
      const a = pool[(s.auctionCursor + i) % pool.length];
      const bankOwned = a.kind === 'property' ? s.ownership.titles[a.propertyId] === 'bank' : unitsOf(s, 'bank', a.companyId) === a.units;
      if (!bankOwned) continue;
      s.auctionCursor = (s.auctionCursor + i + 1) % pool.length;
      s.auction = { id: newId(ctx, 'A'), asset: a, seller: 'bank', reserve: mulDivFloor(auctionAssetValue(s, a), 8000, 10_000), highBid: 0, highBidder: null, passed: [], order, next: 0 };
      break;
    }
  }
  if (s.auction) emit(ctx, 'auction_announced', `Up for auction this year: ${auctionAssetName(s, s.auction.asset)}, reserve ${fmtUsd(s.auction.reserve)}.`, { data: { auctionId: s.auction.id } });
}

export function minBid(s: MatchState): Money {
  const a = s.auction;
  if (!a) return 0;
  return a.highBidder ? a.highBid + MIN_INCREMENT : Math.max(a.reserve, MIN_INCREMENT);
}

/** Next seat that must bid or pass, or null when the auction is decided. */
export function auctionNextSeat(s: MatchState): SeatId | null {
  const a = s.auction;
  if (!a) return null;
  for (let i = 0; i < a.order.length; i++) {
    const seat = a.order[(a.next + i) % a.order.length];
    if (!a.passed.includes(seat) && seat !== a.highBidder) return seat;
  }
  return null;
}

function advanceAuctionCursor(s: MatchState, seat: SeatId): void {
  const a = s.auction;
  if (a) a.next = (a.order.indexOf(seat) + 1) % a.order.length;
}

export function bid(ctx: Ctx, seat: SeatId, amount: Money): void {
  const s = ctx.s;
  const a = s.auction;
  if (!a || auctionNextSeat(s) !== seat) reject('not_your_bid', 'It is not your turn to bid.');
  assertMoney(amount, 'Bid', false);
  if (amount < minBid(s)) reject('bid_too_low', `The minimum bid is ${fmtUsd(minBid(s))}.`);
  if (spendable(s, seat) < amount) reject('insufficient_cash', 'Bids must be backed by spendable cash; expected loans and sales do not count.');
  a.highBid = amount;
  a.highBidder = seat;
  advanceAuctionCursor(s, seat);
  count(s, seat, 'bid');
  emit(ctx, 'auction_bid', `${s.players[seat].name} bid ${fmtUsd(amount)}.`, { seat, data: { amount } });
}

export function passAuction(ctx: Ctx, seat: SeatId): void {
  const s = ctx.s;
  const a = s.auction;
  if (!a || auctionNextSeat(s) !== seat) reject('not_your_bid', 'It is not your turn to bid.');
  a.passed.push(seat);
  advanceAuctionCursor(s, seat);
  emit(ctx, 'auction_pass', `${s.players[seat].name} passed.`, { seat });
}

export function resolveAuction(ctx: Ctx): void {
  const s = ctx.s;
  const a = s.auction;
  if (!a) return;
  const name = auctionAssetName(s, a.asset);
  if (a.highBidder) {
    const w = a.highBidder;
    const bidAmt = a.highBid;
    s.auction = null; // release the winner's reservation before paying
    pay(ctx, acct.player(w), acct.holder(a.seller), bidAmt, `auction ${a.id}`);
    if (a.asset.kind === 'property') {
      moveTitle(ctx, a.asset.propertyId, a.seller, w);
      position(s, w, a.asset.propertyId).spent += bidAmt;
      if (a.seller !== 'bank') position(s, a.seller, a.asset.propertyId).received += bidAmt;
    } else {
      moveUnits(ctx, a.asset.companyId, a.seller, w, a.asset.units);
      position(s, w, a.asset.companyId).spent += bidAmt;
      if (a.seller !== 'bank') position(s, a.seller, a.asset.companyId).received += bidAmt;
    }
    count(s, w, 'auctionWon');
    emit(ctx, 'auction_won', `${s.players[w].name} won ${name} at auction for ${fmtUsd(bidAmt)}.`, { seat: w, data: { amount: bidAmt } });
  } else {
    s.auction = null;
    emit(ctx, 'auction_unsold', `No bids met the reserve on ${name}. It stays with ${a.seller === 'bank' ? 'the bank' : s.players[a.seller].name}.`);
  }
}

export function listAuction(ctx: Ctx, seat: SeatId, asset: AuctionAsset, reserve: Money): void {
  const s = ctx.s;
  assertMoney(reserve, 'Reserve');
  if (s.listings.some((l) => l.seller === seat)) reject('already_listed', 'You already have an asset queued for auction.');
  if (asset.kind === 'property') {
    if (s.ownership.titles[asset.propertyId] !== seat) reject('not_owned', 'You do not own that property.');
    if (propertyPledged(s, asset.propertyId) || propertyReserved(s, asset.propertyId)) reject('encumbered', 'Pledged or reserved assets cannot be listed; repay the loan first.');
    s.listings.push({ seller: seat, asset: { kind: 'property', propertyId: asset.propertyId }, reserve });
  } else {
    const def = defOf(s, asset.companyId);
    assertInt(asset.units, 'Units', 1, def.sharesOutstanding);
    if (availableUnits(s, seat, asset.companyId) < asset.units) reject('encumbered', 'You do not have that many unpledged, unreserved units.');
    s.listings.push({ seller: seat, asset: { kind: 'units', companyId: asset.companyId, units: asset.units }, reserve });
  }
  emit(ctx, 'auction_listed', `${s.players[seat].name} listed ${auctionAssetName(s, asset)} for next year's auction.`, { seat });
}

// ---------- tender offers ----------
export function minTenderPrice(s: MatchState, companyId: string): Money {
  return -Math.floor((-valueCompany(s, companyId).mark * 11_000) / 10_000);
}

export function launchTender(ctx: Ctx, seat: SeatId, companyId: string, price: Money, maxShares: number, minShares: number): void {
  const s = ctx.s;
  const def = defOf(s, companyId);
  if (def.kind !== 'public') reject('not_listed', 'Tender offers are for public companies.');
  if (s.tender) reject('tender_open', 'Another tender offer is already open this year.');
  assertMoney(price, 'Price', false);
  if (price < minTenderPrice(s, companyId)) reject('price_too_low', `A tender must offer at least 110% of the market price (${fmtUsd(minTenderPrice(s, companyId))}).`);
  const others = def.sharesOutstanding - unitsOf(s, seat, companyId);
  assertInt(maxShares, 'Maximum shares', 1, others);
  assertInt(minShares, 'Minimum shares', 1, maxShares);
  if (spendable(s, seat) < price * maxShares) reject('insufficient_cash', `You must escrow ${fmtUsd(price * maxShares)} in cash.`);
  s.tender = { id: newId(ctx, 'T'), bidder: seat, companyId, price, maxShares, minShares, responses: {} };
  count(s, seat, 'tender');
  emit(ctx, 'tender_launched', `${s.players[seat].name} launched a tender for up to ${maxShares} ${def.ticker} at ${fmtUsd(price)} a share (needs ${minShares}).`, { seat, data: { companyId, price, maxShares, minShares } });
}

/** Next player holder who has not yet answered the open tender. */
export function tenderNextSeat(s: MatchState): SeatId | null {
  const t = s.tender;
  if (!t) return null;
  for (const seat of s.seatOrder) {
    if (seat === t.bidder || t.responses[seat] !== undefined) continue;
    if (availableUnits(s, seat, t.companyId) > 0) return seat;
  }
  return null;
}

export function tenderResponse(ctx: Ctx, seat: SeatId, shares: number): void {
  const s = ctx.s;
  const t = s.tender;
  if (!t || tenderNextSeat(s) !== seat) reject('not_your_response', 'There is no tender waiting for your answer.');
  assertInt(shares, 'Shares', 0, availableUnits(s, seat, t.companyId));
  t.responses[seat] = shares;
  emit(ctx, 'tender_response', `${s.players[seat].name} ${shares > 0 ? `tendered ${shares} shares` : 'declined to tender'}.`, { seat, data: { shares } });
}

export function resolveTender(ctx: Ctx): void {
  const s = ctx.s;
  const t = s.tender;
  if (!t) return;
  const def = defOf(s, t.companyId);
  const offered: Record<string, number> = { bank: unitsOf(s, 'bank', t.companyId) };
  for (const [seat, n] of Object.entries(t.responses)) if (n > 0) offered[seat] = n;
  const order = holdersOf(s, t.companyId).filter((h) => (offered[h] ?? 0) > 0);
  const total = order.reduce((a, h) => a + offered[h], 0);
  s.tender = null; // releases escrow and tendered-share reservations
  if (total < t.minShares) {
    addRep(ctx, t.bidder, -5);
    emit(ctx, 'tender_failed', `${s.players[t.bidder].name}'s tender for ${def.ticker} failed: only ${total} of ${t.minShares} shares came in. Escrow refunded; reputation −5.`, { seat: t.bidder });
    return;
  }
  const fill = Math.min(total, t.maxShares);
  const alloc = fill === total ? offered : distribute(fill, offered, order);
  for (const h of order) {
    const n = alloc[h] ?? 0;
    if (n <= 0) continue;
    pay(ctx, acct.player(t.bidder), acct.holder(h), t.price * n, `tender ${t.id}`);
    moveUnits(ctx, t.companyId, h, t.bidder, n);
    if (h !== 'bank') position(s, h, t.companyId).received += t.price * n;
  }
  position(s, t.bidder, t.companyId).spent += t.price * fill;
  emit(ctx, 'tender_filled', `${s.players[t.bidder].name}'s tender succeeded: ${fill} ${def.ticker} bought at ${fmtUsd(t.price)} a share.`, { seat: t.bidder, data: { shares: fill } });
}
