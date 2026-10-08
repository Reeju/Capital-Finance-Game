// Turn actions on assets: exchange orders, bank asset purchases/buybacks, upgrades and corporate policy.
import {
  type Ctx, acct, activeLoans, availableUnits, count, defOf, emit, moveTitle, moveUnits, pay, position, propDefOf, propertyPledged,
  propertyReserved, spendable, unitsOf,
} from './core';
import { payLoan } from './loans';
import { assertInt, assertMoney, clamp, fmtUsd, mulBps, mulDivFloor, reject } from './money';
import { forecastGrowth, propertyValue, unitValue, valueCompany } from './valuation';
import type { Bps, Loan, MatchState, Money, SeatId } from './types';

export const SPREAD_BPS = 50;
export const UPGRADE_COST: Money = 30_000_00;
export const PAYOUT_CHOICES = [0, 2500, 5000, 7500];

export interface MarketQuote {
  companyId: string; shares: number; mark: Money; spreadBps: Bps; impactBps: Bps; total: Money; fee: Money; perShare: Money;
  cashAfter: Money; revision: number; distress: boolean;
}

/** Executable quote at the current revision. Positive shares buy from the bank float; negative sell to it. */
export function quoteMarket(s: MatchState, seat: SeatId, companyId: string, shares: number, distress = false): MarketQuote {
  const def = defOf(s, companyId);
  const mark = valueCompany(s, companyId).mark;
  const q = Math.abs(shares);
  // Size impact uses this seat's own net flow in the company this round, so splitting an order does not dodge it
  // and acting later in the turn order does not cost more.
  const flow = s.flow[`${seat}:${companyId}`] ?? 0;
  const pressure = shares > 0 ? Math.max(0, flow + q) : Math.max(0, q - flow);
  const impactBps = Math.min(1200, Math.floor((10_000 * pressure) / (def.sharesOutstanding * 5)));
  const gross = mark * q;
  let total: Money;
  if (shares > 0) total = -Math.floor((-gross * (10_000 + SPREAD_BPS + impactBps)) / 10_000);
  else total = mulDivFloor(distress ? mulDivFloor(gross, 9500, 10_000) : gross, 10_000 - SPREAD_BPS - impactBps, 10_000);
  const fee = Math.abs(total - gross);
  return {
    companyId, shares, mark, spreadBps: SPREAD_BPS, impactBps, total, fee, perShare: q > 0 ? Math.round(total / q) : 0,
    cashAfter: s.players[seat].cash + (shares > 0 ? -total : total), revision: s.revision, distress,
  };
}

/** Loans of `seat` secured on this asset. Selling it requires paying them off from the proceeds. */
export function loansSecuredOn(s: MatchState, seat: SeatId, key: { companyId?: string; propertyId?: string }): Loan[] {
  return activeLoans(s).filter((l) => l.borrower === seat && l.collateral.some((c) => (c.kind === 'units' ? c.companyId === key.companyId : c.propertyId === key.propertyId)));
}

/** Release encumbered collateral by repaying its loans in full out of sale proceeds (already credited). */
export function releaseWithProceeds(ctx: Ctx, seat: SeatId, loans: Loan[], proceeds: Money): void {
  const payoff = loans.reduce((a, l) => a + l.principal + l.arrears, 0);
  if (payoff > proceeds) reject('encumbered', `That asset secures ${fmtUsd(payoff)} of debt; the sale must raise at least that much to release it.`);
  for (const l of loans) payLoan(ctx, l, l.principal + l.arrears, 'release');
}

export function marketOrder(ctx: Ctx, seat: SeatId, companyId: string, shares: number, distress: boolean): void {
  const s = ctx.s;
  const def = defOf(s, companyId);
  if (def.kind !== 'public') reject('not_listed', 'Private businesses do not trade on the exchange.');
  assertInt(Math.abs(shares), 'Share count', 1, def.sharesOutstanding);
  if (distress && shares > 0) reject('rescue_only', 'You can only sell during a rescue.');
  const q = quoteMarket(s, seat, companyId, shares, distress);
  if (shares > 0) {
    if (unitsOf(s, 'bank', companyId) < shares) reject('no_float', `Only ${unitsOf(s, 'bank', companyId)} shares are left in the free float.`);
    if (spendable(s, seat) < q.total) reject('insufficient_cash', `You need ${fmtUsd(q.total)} in spendable cash.`);
    pay(ctx, acct.player(seat), 'bank', q.total, `buy ${shares} ${def.ticker}`);
    moveUnits(ctx, companyId, 'bank', seat, shares);
    position(s, seat, companyId).spent += q.total;
    emit(ctx, 'market_buy', `${s.players[seat].name} bought ${shares} ${def.ticker} for ${fmtUsd(q.total)}.`, { seat, data: { companyId, shares, total: q.total } });
  } else {
    const n = -shares;
    const owned = unitsOf(s, seat, companyId);
    const free = availableUnits(s, seat, companyId);
    if (owned < n) reject('not_owned', 'You do not own that many shares.');
    pay(ctx, 'bank', acct.player(seat), q.total, `sell ${n} ${def.ticker}`);
    if (free < n) {
      const secured = loansSecuredOn(s, seat, { companyId });
      if (secured.length === 0) reject('reserved', 'Some of those shares are reserved by an open offer or contract.');
      releaseWithProceeds(ctx, seat, secured, q.total);
      if (availableUnits(s, seat, companyId) < n) reject('reserved', 'Some of those shares are reserved by an open offer or contract.');
    }
    moveUnits(ctx, companyId, seat, 'bank', n);
    position(s, seat, companyId).received += q.total;
    emit(ctx, 'market_sell', `${s.players[seat].name} sold ${n} ${def.ticker} for ${fmtUsd(q.total)}.`, { seat, data: { companyId, shares: n, total: q.total } });
  }
  s.flow[`${seat}:${companyId}`] = (s.flow[`${seat}:${companyId}`] ?? 0) + shares;
  count(s, seat, shares > 0 ? 'buyStock' : 'sellStock');
}

export function bankAskBusiness(s: MatchState, companyId: string): Money {
  return -Math.floor((-valueCompany(s, companyId).equity * 10_500) / 10_000);
}

export function bankAskProperty(s: MatchState, propertyId: string): Money {
  return -Math.floor((-propertyValue(s, propertyId) * 10_500) / 10_000);
}

export function bankBidBusiness(s: MatchState, companyId: string, units: number, distress: boolean): Money {
  return mulDivFloor(unitValue(s, companyId, units), distress ? 6000 : s.macro.regime === 'crisis' ? 6000 : 7500, 10_000);
}

export function bankBidProperty(s: MatchState, propertyId: string, distress: boolean): Money {
  return mulDivFloor(propertyValue(s, propertyId), distress ? 6500 : s.macro.regime === 'crisis' ? 6500 : 8000, 10_000);
}

function inAuction(s: MatchState, key: { companyId?: string; propertyId?: string }): boolean {
  const a = s.auction?.asset;
  return !!a && (a.kind === 'units' ? a.companyId === key.companyId : a.propertyId === key.propertyId);
}

export function buyBusiness(ctx: Ctx, seat: SeatId, companyId: string): void {
  const s = ctx.s;
  const def = defOf(s, companyId);
  if (def.kind !== 'private') reject('not_private', 'Public shares are bought on the exchange.');
  if (unitsOf(s, 'bank', companyId) !== def.sharesOutstanding) reject('unavailable', 'The bank no longer has this business on offer.');
  if (inAuction(s, { companyId })) reject('in_auction', 'This business is this year\'s auction lot.');
  const price = bankAskBusiness(s, companyId);
  if (spendable(s, seat) < price) reject('insufficient_cash', `You need ${fmtUsd(price)} in spendable cash.`);
  pay(ctx, acct.player(seat), 'bank', price, `buy ${def.name}`);
  moveUnits(ctx, companyId, 'bank', seat, def.sharesOutstanding);
  position(s, seat, companyId).spent += price;
  count(s, seat, 'buyBusiness');
  emit(ctx, 'asset_bought', `${s.players[seat].name} bought ${def.name} for ${fmtUsd(price)}.`, { seat, data: { assetId: companyId, price } });
}

export function buyProperty(ctx: Ctx, seat: SeatId, propertyId: string): void {
  const s = ctx.s;
  const def = propDefOf(s, propertyId);
  if (s.ownership.titles[propertyId] !== 'bank') reject('unavailable', 'That property is not for sale by the bank.');
  if (inAuction(s, { propertyId })) reject('in_auction', 'This property is this year\'s auction lot.');
  const price = bankAskProperty(s, propertyId);
  if (spendable(s, seat) < price) reject('insufficient_cash', `You need ${fmtUsd(price)} in spendable cash.`);
  pay(ctx, acct.player(seat), 'bank', price, `buy ${def.name}`);
  moveTitle(ctx, propertyId, 'bank', seat);
  position(s, seat, propertyId).spent += price;
  count(s, seat, 'buyProperty');
  emit(ctx, 'asset_bought', `${s.players[seat].name} bought ${def.name} for ${fmtUsd(price)}.`, { seat, data: { assetId: propertyId, price } });
}

export function sellBusiness(ctx: Ctx, seat: SeatId, companyId: string, units: number, distress: boolean): void {
  const s = ctx.s;
  const def = defOf(s, companyId);
  if (def.kind !== 'private') reject('not_private', 'Public shares are sold on the exchange.');
  assertInt(units, 'Units', 1, def.sharesOutstanding);
  if (unitsOf(s, seat, companyId) < units) reject('not_owned', 'You do not own that many units.');
  const price = bankBidBusiness(s, companyId, units, distress);
  pay(ctx, 'bank', acct.player(seat), price, `sell ${def.name}`);
  if (availableUnits(s, seat, companyId) < units) {
    const secured = loansSecuredOn(s, seat, { companyId });
    if (secured.length === 0) reject('reserved', 'Those units are reserved by an open offer or contract.');
    releaseWithProceeds(ctx, seat, secured, price);
    if (availableUnits(s, seat, companyId) < units) reject('reserved', 'Those units are reserved by an open offer or contract.');
  }
  moveUnits(ctx, companyId, seat, 'bank', units);
  position(s, seat, companyId).received += price;
  count(s, seat, 'sellAsset');
  emit(ctx, 'asset_sold', `${s.players[seat].name} sold ${units === def.sharesOutstanding ? '' : `${(units / 100).toFixed(0)}% of `}${def.name} back to the bank for ${fmtUsd(price)}.`, { seat, data: { assetId: companyId, price } });
}

export function sellProperty(ctx: Ctx, seat: SeatId, propertyId: string, distress: boolean): void {
  const s = ctx.s;
  const def = propDefOf(s, propertyId);
  if (s.ownership.titles[propertyId] !== seat) reject('not_owned', 'You do not own that property.');
  if (propertyReserved(s, propertyId)) reject('reserved', 'That property is reserved by an open offer or listing.');
  const price = bankBidProperty(s, propertyId, distress);
  pay(ctx, 'bank', acct.player(seat), price, `sell ${def.name}`);
  if (propertyPledged(s, propertyId)) releaseWithProceeds(ctx, seat, loansSecuredOn(s, seat, { propertyId }), price);
  moveTitle(ctx, propertyId, seat, 'bank');
  position(s, seat, propertyId).received += price;
  count(s, seat, 'sellAsset');
  emit(ctx, 'asset_sold', `${s.players[seat].name} sold ${def.name} back to the bank for ${fmtUsd(price)}.`, { seat, data: { assetId: propertyId, price } });
}

export function upgradeProperty(ctx: Ctx, seat: SeatId, propertyId: string): void {
  const s = ctx.s;
  const def = propDefOf(s, propertyId);
  const p = s.properties[propertyId];
  if (s.ownership.titles[propertyId] !== seat) reject('not_owned', 'You do not own that property.');
  if (p.upgrades >= def.upgradesMax) reject('maxed', 'This property is fully upgraded.');
  if (spendable(s, seat) < UPGRADE_COST) reject('insufficient_cash', `An upgrade costs ${fmtUsd(UPGRADE_COST)}.`);
  pay(ctx, acct.player(seat), 'economy', UPGRADE_COST, `upgrade ${def.name}`);
  p.upgrades += 1;
  p.grossRent += 4_000_00;
  p.expense += 1_000_00;
  position(s, seat, propertyId).spent += UPGRADE_COST;
  count(s, seat, 'upgrade');
  emit(ctx, 'property_upgraded', `${s.players[seat].name} upgraded ${def.name}: +$4,000 rent, +$1,000 costs a year.`, { seat, data: { assetId: propertyId } });
}

function requireControl(s: MatchState, seat: SeatId, companyId: string): void {
  defOf(s, companyId);
  if (s.control[companyId] !== seat) reject('no_control', 'You need more than 50% ownership to set company policy.');
  if (s.companies[companyId].policyRound === s.round) reject('once_per_round', 'This company has already had a policy action this year.');
}

export function setPolicy(ctx: Ctx, seat: SeatId, companyId: string, payout: Bps): void {
  const s = ctx.s;
  requireControl(s, seat, companyId);
  if (!PAYOUT_CHOICES.includes(payout)) reject('bad_payout', 'Payout must be 0%, 25%, 50% or 75%.');
  const co = s.companies[companyId];
  co.payout = payout;
  co.policyRound = s.round;
  count(s, seat, 'policy');
  emit(ctx, 'policy_set', `${s.players[seat].name} set ${defOf(s, companyId).name}'s payout to ${payout / 100}%.`, { seat, data: { companyId, payout } });
}

export function reinvestBoost(revenue: Money, amount: Money): Bps {
  return clamp(mulDivFloor(10_000, amount, Math.max(revenue, 1)), 0, 800);
}

export function reinvest(ctx: Ctx, seat: SeatId, companyId: string, amount: Money): void {
  const s = ctx.s;
  requireControl(s, seat, companyId);
  const co = s.companies[companyId];
  assertMoney(amount, 'Reinvestment', false);
  if (co.arrears > 0) reject('arrears', 'A company with arrears cannot reinvest.');
  if (amount > co.cash) reject('insufficient_cash', `The company only has ${fmtUsd(co.cash)}.`);
  pay(ctx, acct.company(companyId), 'economy', amount, `reinvest ${companyId}`);
  co.pendingBoost = reinvestBoost(co.revenue, amount);
  co.policyRound = s.round;
  count(s, seat, 'reinvest');
  emit(ctx, 'reinvested', `${defOf(s, companyId).name} reinvested ${fmtUsd(amount)}: +${(co.pendingBoost / 100).toFixed(1)}% growth next year.`, { seat, data: { companyId, amount } });
}

export function corpRepay(ctx: Ctx, seat: SeatId, companyId: string, amount: Money): void {
  const s = ctx.s;
  requireControl(s, seat, companyId);
  const co = s.companies[companyId];
  assertMoney(amount, 'Repayment', false);
  if (amount > co.cash) reject('insufficient_cash', `The company only has ${fmtUsd(co.cash)}.`);
  if (amount > co.debt + co.arrears) reject('too_much', 'That is more than the company owes.');
  pay(ctx, acct.company(companyId), 'bank', amount, `corporate repayment ${companyId}`);
  const toArrears = Math.min(amount, co.arrears);
  co.arrears -= toArrears;
  co.debt -= amount - toArrears;
  co.policyRound = s.round;
  emit(ctx, 'corp_repaid', `${defOf(s, companyId).name} paid down ${fmtUsd(amount)} of corporate debt.`, { seat, data: { companyId, amount } });
}

export interface CorpRefiQuote { approved: boolean; reasons: string[]; rate: Bps; maturityRound: number }

export function quoteCorpRefinance(s: MatchState, companyId: string): CorpRefiQuote {
  const def = defOf(s, companyId);
  const co = s.companies[companyId];
  const v = valueCompany(s, companyId);
  const rate = clamp(s.macro.rate + 200 + 50 * def.risk, 400, 1500);
  const reasons: string[] = [];
  if (co.debt <= 0) reasons.push('There is no corporate debt to refinance.');
  if (co.arrears > 0) reasons.push('Clear corporate arrears first.');
  if (co.debt * 10 > v.ev * 6) reasons.push('Corporate debt exceeds 60% of enterprise value.');
  const projEBIT = co.lastEBIT + mulBps(co.lastEBIT, forecastGrowth(s, companyId).total);
  if (co.cash + mulBps(projEBIT, 8000) < mulBps(co.debt, rate)) reasons.push('Cash plus 80% of projected profit would not cover a year of interest.');
  return { approved: reasons.length === 0, reasons, rate, maturityRound: s.round + 5 };
}

export function corpRefinance(ctx: Ctx, seat: SeatId, companyId: string): void {
  const s = ctx.s;
  requireControl(s, seat, companyId);
  const q = quoteCorpRefinance(s, companyId);
  if (!q.approved) reject('refi_refused', q.reasons[0]);
  const co = s.companies[companyId];
  co.debtRate = q.rate;
  co.debtMaturity = q.maturityRound;
  co.policyRound = s.round;
  emit(ctx, 'corp_refinanced', `${defOf(s, companyId).name} refinanced its debt at ${(q.rate / 100).toFixed(2)}% for five years.`, { seat, data: { companyId, rate: q.rate } });
}
