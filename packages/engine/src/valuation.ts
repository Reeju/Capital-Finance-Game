// Fundamentals -> fair value -> market mark, and the single portfolio valuation used by HUD and endgame.
import { activeLoans, controllerOf, defOf, propDefOf, unitsOf } from './core';
import { clamp, divRound, mulBps, mulDiv, mulDivFloor } from './money';
import type { Bps, CompanyDef, HolderId, Loan, MatchState, Money, Pledge, SeatId } from './types';

export const EQUITY_FLOOR: Money = 10_000_00;
export const PRICE_FLOOR: Money = 50;
export const PRICE_CEIL: Money = 1_000_00;

export function modifierSum(s: MatchState, metric: string, targets: string[]): number {
  let n = 0;
  for (const m of s.modifiers) if (m.metric === metric && targets.includes(m.target)) n += m.delta;
  return n;
}

function targetsFor(def: CompanyDef): string[] {
  return [`sector:${def.sector}`, `company:${def.id}`, 'all'];
}

export interface GrowthBreakdown { base: Bps; gdp: Bps; confidence: Bps; events: Bps; reinvestment: Bps; total: Bps }

/** Public expected growth: same inputs as the Close update, without the hidden shock or sector demand. */
export function forecastGrowth(s: MatchState, companyId: string): GrowthBreakdown {
  const def = defOf(s, companyId);
  const sec = s.content.sectors[def.sector];
  const gdp = divRound(sec.gdpBeta * (s.macro.gdp - 200), 100);
  const confidence = sec.confBeta * (s.macro.confidence - 50);
  const events = modifierSum(s, 'growth', targetsFor(def));
  const reinvestment = s.companies[companyId].boost;
  return { base: def.baseGrowth, gdp, confidence, events, reinvestment, total: def.baseGrowth + gdp + confidence + events + reinvestment };
}

export function synergyBps(s: MatchState, companyId: string): Bps {
  let n = 0;
  for (const syn of s.content.synergies) {
    if (!syn.companyIds.includes(companyId)) continue;
    const owner = s.ownership.titles[syn.propertyId];
    if (owner !== 'bank' && controllerOf(s, companyId) === owner) n = Math.max(n, syn.marginBps);
  }
  return n;
}

export interface MarginBreakdown { base: Bps; events: Bps; commodity: Bps; synergy: Bps; total: Bps }

export function currentMargin(s: MatchState, companyId: string): MarginBreakdown {
  const def = defOf(s, companyId);
  const events = modifierSum(s, 'margin', targetsFor(def));
  const commodity = s.content.sectors[def.sector].commoditySens * (s.macro.commodity - 100);
  const synergy = synergyBps(s, companyId);
  return { base: def.baseMargin, events, commodity, synergy, total: clamp(def.baseMargin + events + commodity + synergy, 300, 4000) };
}

export interface CompanyValuation {
  normalizedEBIT: Money; multipleBps: Bps; growthAdj: Bps; rateAdj: Bps; riskAdj: Bps; ev: Money; equity: Money;
  fairPerShare: Money; mark: Money; sentimentBps: Bps;
}

export function valueCompany(s: MatchState, companyId: string): CompanyValuation {
  const def = defOf(s, companyId);
  const co = s.companies[companyId];
  const sec = s.content.sectors[def.sector];
  const growthAdj = 2 * (forecastGrowth(s, companyId).total - def.baseGrowth);
  const rateAdj = -divRound(sec.rateSens * (s.macro.rate - 400), 100);
  const riskAdj = -def.risk * 100;
  const multipleBps = clamp(def.baseMultiple + growthAdj + rateAdj + riskAdj, 30_000, 140_000);
  const normalizedEBIT = Math.max(co.lastEBIT, mulBps(co.revenue, 500));
  const ev = mulDiv(normalizedEBIT, multipleBps, 10_000);
  const equity = Math.max(ev + co.cash - co.debt - co.arrears, EQUITY_FLOOR);
  const fairPerShare = divRound(equity, def.sharesOutstanding);
  let mark = fairPerShare;
  let sentimentBps = 10_000;
  if (def.kind === 'public') {
    sentimentBps = mulDiv(mulDiv(s.macro.sentiment, s.macro.sectorSentiment[def.sector], 10_000), co.sentiment, 10_000);
    mark = clamp(mulDiv(fairPerShare, sentimentBps, 10_000), PRICE_FLOOR, PRICE_CEIL);
  }
  return { normalizedEBIT, multipleBps, growthAdj, rateAdj, riskAdj, ev, equity, fairPerShare, mark, sentimentBps };
}

/** Marked value of a unit stake: public at market mark, private at pro-rata fair equity. */
export function unitValue(s: MatchState, companyId: string, units: number): Money {
  if (units <= 0) return 0;
  const def = defOf(s, companyId);
  const v = valueCompany(s, companyId);
  return def.kind === 'public' ? v.mark * units : mulDivFloor(v.equity, units, def.sharesOutstanding);
}

export function effectivePayout(s: MatchState, companyId: string): Bps {
  const def = defOf(s, companyId);
  if (s.control[companyId]) return s.companies[companyId].payout;
  return def.kind === 'private' ? 5000 : def.payout;
}

export function capRate(s: MatchState, propertyId: string): Bps {
  const def = propDefOf(s, propertyId);
  return clamp(def.capRate + divRound(s.macro.rate - 400, 2) + s.macro.credit * 2 - 80, 500, 1600);
}

export function propertyNOI(s: MatchState, propertyId: string): Money {
  const p = s.properties[propertyId];
  return mulBps(p.grossRent, p.occupancy) - p.expense;
}

export function propertyValue(s: MatchState, propertyId: string): Money {
  return mulDiv(Math.max(propertyNOI(s, propertyId), 1_000_00), 10_000, capRate(s, propertyId));
}

export function pledgeValue(s: MatchState, p: Pledge): Money {
  return p.kind === 'units' ? unitValue(s, p.companyId, p.units) : propertyValue(s, p.propertyId);
}

/** Lending value after collateral haircuts: public 50% of mark, property 60%, private business 35%. */
export function pledgeLendingValue(s: MatchState, p: Pledge): Money {
  if (p.kind === 'property') return mulBps(propertyValue(s, p.propertyId), 6000);
  return mulBps(unitValue(s, p.companyId, p.units), defOf(s, p.companyId).kind === 'public' ? 5000 : 3500);
}

export function loanOwed(l: Loan): Money {
  return l.status === 'paid' ? 0 : l.principal + l.arrears + l.accruedInterest;
}

/** What a lender can count: full claim when performing, 50% while a restructured claim is outstanding. */
export function loanReceivableValue(l: Loan): Money {
  return l.status === 'restructured' || l.status === 'delinquent' ? Math.floor(loanOwed(l) / 2) : loanOwed(l);
}

export function contractValue(s: MatchState, c: MatchState['contracts'][number]): Money {
  const raw = mulDivFloor(c.trailing * c.roundsLeft, 8, 10);
  return Math.min(raw, unitValue(s, c.companyId, Math.min(c.units, unitsOf(s, c.seller, c.companyId))));
}

export interface PortfolioValuation {
  cash: Money; publicShares: Money; privateEquity: Money; property: Money; receivables: Money; rights: Money; assets: Money;
  loanPrincipal: Money; arrears: Money; liabilities: Money; netWorth: Money; grants: Money; bonus: Money; adjusted: Money; leverageBps: Bps;
}

export function valuePortfolio(s: MatchState, seat: SeatId): PortfolioValuation {
  const p = s.players[seat];
  let publicShares = 0;
  let privateEquity = 0;
  for (const def of s.content.companies) {
    const v = unitValue(s, def.id, unitsOf(s, seat, def.id));
    if (def.kind === 'public') publicShares += v;
    else privateEquity += v;
  }
  let property = 0;
  for (const def of s.content.properties) if (s.ownership.titles[def.id] === seat) property += propertyValue(s, def.id);
  let receivables = 0;
  let loanPrincipal = 0;
  let arrears = p.propertyArrears;
  for (const l of activeLoans(s)) {
    if (l.lender === seat) receivables += loanReceivableValue(l);
    if (l.borrower === seat) {
      loanPrincipal += l.principal;
      arrears += l.arrears + l.accruedInterest;
    }
  }
  let rights = 0;
  for (const c of s.contracts) {
    const v = contractValue(s, c);
    if (c.buyer === seat) rights += v;
    if (c.seller === seat) rights -= v;
  }
  const assets = p.cash + publicShares + privateEquity + property + receivables + rights;
  const liabilities = loanPrincipal + arrears;
  const netWorth = assets - liabilities;
  const bonus = p.reputation * 100_00;
  const leverageBps = assets > 0 ? mulDiv(loanPrincipal, 10_000, assets) : loanPrincipal > 0 ? 99_999 : 0;
  return {
    cash: p.cash, publicShares, privateEquity, property, receivables, rights, assets, loanPrincipal, arrears, liabilities, netWorth,
    grants: p.grants, bonus, adjusted: netWorth - p.grants + bonus, leverageBps,
  };
}

/** Next Close's scheduled payment on one loan (interest + due principal + existing arrears). */
export function loanService(s: MatchState, l: Loan): { interest: Money; principal: Money; arrears: Money; total: Money } {
  if (l.status === 'paid' || (l.lender !== 'bank' && l.originatedRound === s.round)) return { interest: 0, principal: 0, arrears: l.arrears, total: l.arrears };
  const interest = mulBps(l.principal, l.rate);
  const principal = s.round >= l.maturityRound ? l.principal : Math.min(l.annualPrincipal, l.principal);
  return { interest, principal, arrears: l.arrears, total: interest + principal + l.arrears };
}

export function debtService(s: MatchState, seat: SeatId): Money {
  let n = s.players[seat].propertyArrears;
  for (const l of activeLoans(s)) if (l.borrower === seat) n += loanService(s, l).total;
  return n;
}

export function annualInterest(s: MatchState, seat: SeatId): Money {
  let n = 0;
  for (const l of activeLoans(s)) if (l.borrower === seat) n += mulBps(l.principal, l.rate);
  return n;
}

export function cashInterestRate(s: MatchState): Bps {
  return clamp(s.macro.rate - 200, 0, 300);
}

/** Conservative look at next Close's income from current holdings: last dividends, current NOI and cash interest. */
export function forecastIncome(s: MatchState, seat: SeatId, cashOverride?: Money): Money {
  let n = 0;
  for (const def of s.content.companies) {
    const u = unitsOf(s, seat, def.id);
    if (u > 0 && s.companies[def.id].arrears === 0) n += mulDivFloor(expectedDividend(s, def.id), u, def.sharesOutstanding);
  }
  for (const def of s.content.properties) if (s.ownership.titles[def.id] === seat) n += propertyNOI(s, def.id);
  n += mulBps(cashOverride ?? s.players[seat].cash, cashInterestRate(s));
  for (const l of activeLoans(s)) if (l.lender === seat) n += mulBps(l.principal, l.rate);
  return n;
}

/** Expected total dividend at next Close from public data (last EBIT, current debt and payout policy). */
export function expectedDividend(s: MatchState, companyId: string): Money {
  const co = s.companies[companyId];
  const net = co.lastEBIT - mulBps(co.debt, co.debtRate);
  return net > 0 ? mulBps(net, effectivePayout(s, companyId)) : 0;
}

export function liquidityWarning(s: MatchState, seat: SeatId): boolean {
  const v = valuePortfolio(s, seat);
  const due = debtService(s, seat);
  return due > 0 && s.players[seat].cash + mulBps(v.publicShares, 2000) < due;
}

export function holdersOf(s: MatchState, companyId: string): HolderId[] {
  const book = s.ownership.units[companyId] ?? {};
  const seats = Object.keys(book).filter((h) => h !== 'bank' && book[h] > 0).sort();
  return (book.bank ?? 0) > 0 ? [...seats, 'bank'] : seats;
}
