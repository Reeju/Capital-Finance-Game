// Bank and player loans: underwriting, repayment, Close obligations, rescue and automatic restructuring.
import {
  type Ctx, acct, activeLoans, addRep, availableUnits, count, defOf, emit, moveTitle, moveUnits, newId, pay, pledgeKey, position,
  propertyPledged, propertyReserved, spendable, unitsOf,
} from './core';
import { assertInt, assertMoney, clamp, fmtUsd, mulBps, mulDiv, mulDivFloor, reject } from './money';
import {
  annualInterest, debtService, forecastIncome, loanService, pledgeLendingValue, pledgeValue, propertyValue, unitValue, valueCompany, valuePortfolio,
} from './valuation';
import type { Bps, Loan, MatchState, Money, Pledge, SeatId } from './types';

export const MIN_LOAN: Money = 10_000_00;
export const RESTART_GRANT: Money = 50_000_00;

export interface LoanQuote {
  approved: boolean; reasons: string[]; rate: Bps; spread: Bps; leverageBps: Bps; annualPrincipal: Money; firstInterest: Money;
  firstPayment: Money; unsecuredCeiling: Money; collateralValue: Money; maxDebt: Money; debtAfter: Money; cashAfter: Money;
}

export function validatePledges(s: MatchState, seat: SeatId, collateral: Pledge[]): string | null {
  const seen = new Set<string>();
  for (const p of collateral) {
    const k = pledgeKey(p);
    if (seen.has(k)) return 'Each asset can be listed once per loan.';
    seen.add(k);
    if (p.kind === 'units') {
      if (!s.companies[p.companyId] || !Number.isSafeInteger(p.units) || p.units <= 0) return 'Invalid collateral units.';
      if (availableUnits(s, seat, p.companyId) < p.units) return 'Those units are already pledged, reserved or not owned.';
    } else {
      if (s.ownership.titles[p.propertyId] !== seat) return 'You do not own that property.';
      if (propertyPledged(s, p.propertyId) || propertyReserved(s, p.propertyId)) return 'That property is already pledged or reserved.';
    }
  }
  return null;
}

/**
 * Underwrite a new bank loan against the post-funding balance sheet. `replacing` is a loan being refinanced:
 * its principal is treated as repaid and its collateral as carried over.
 */
export function quoteLoan(
  s: MatchState, seat: SeatId, principal: Money, term: number, rateType: 'fixed' | 'floating', collateral: Pledge[], replacing?: Loan,
): LoanQuote {
  const p = s.players[seat];
  const v = valuePortfolio(s, seat);
  const reasons: string[] = [];
  const payoff = replacing ? replacing.principal + replacing.arrears : 0;
  const fee = replacing ? mulBps(payoff, 100) : 0;
  const cashAfter = p.cash + principal - payoff - fee;
  const assetsAfter = v.assets + principal - payoff - fee;
  const debtAfter = v.loanPrincipal + principal - (replacing ? replacing.principal : 0);
  const netWorthAfter = v.netWorth - fee;
  const leverageBps = assetsAfter > 0 ? mulDiv(debtAfter, 10_000, assetsAfter) : 99_999;
  const tier = leverageBps < 2000 ? 100 : leverageBps < 5000 ? 200 : leverageBps < 7000 ? 400 : 700;
  const spread = tier + Math.max(0, 60 - p.reputation) * 5 + s.macro.credit * 2 + (rateType === 'fixed' ? 50 : 0);
  const rate = clamp(s.macro.rate + spread, 400, 1500);
  const annualPrincipal = Math.ceil(principal / term);
  const firstInterest = mulBps(principal, rate);

  if (principal < MIN_LOAN) reasons.push('The minimum loan is $10,000.');
  if (s.round < p.freezeUntil) reasons.push(`New bank borrowing is frozen until year ${p.freezeUntil} after your restructuring.`);
  if (netWorthAfter <= 0) reasons.push('The bank will not lend to a borrower with no net worth.');
  if (leverageBps > 7000) reasons.push('Debt would exceed 70% of your assets.');
  if (netWorthAfter > 0 && debtAfter * 2 > netWorthAfter * 3) reasons.push('Total debt would exceed 1.5× your net worth.');
  const pledgeErr = validatePledges(s, seat, collateral);
  if (pledgeErr) reasons.push(pledgeErr);

  const unsecuredCeiling = mulDivFloor(100_000_00 + mulBps(Math.max(0, netWorthAfter), 2000), 100 - s.macro.credit, 100);
  let collateralValue = 0;
  if (!pledgeErr) for (const c of collateral) collateralValue += pledgeLendingValue(s, c);
  for (const l of activeLoans(s)) if (l.borrower === seat && l.lender === 'bank') for (const c of l.collateral) collateralValue += pledgeLendingValue(s, c);
  const maxDebt = unsecuredCeiling + collateralValue;
  if (debtAfter > maxDebt) reasons.push(`Total debt ${fmtUsd(debtAfter)} would exceed your credit ceiling of ${fmtUsd(maxDebt)} (unsecured ${fmtUsd(unsecuredCeiling)} + collateral ${fmtUsd(collateralValue)}).`);

  let service = debtService(s, seat) + firstInterest + annualPrincipal;
  let interest = annualInterest(s, seat) + firstInterest;
  if (replacing) {
    service -= loanService(s, replacing).total;
    interest -= mulBps(replacing.principal, replacing.rate);
  }
  if (cashAfter + mulBps(v.publicShares, 2000) < service) reasons.push('Cash plus 20% of your public shares would not cover next year\'s debt service.');
  const income = mulBps(forecastIncome(s, seat, Math.max(0, cashAfter)), 8000);
  if (income * 2 < interest) reasons.push('Forecast income (with a 20% haircut) covers less than half of your annual interest.');
  return {
    approved: reasons.length === 0, reasons, rate, spread: rate - s.macro.rate, leverageBps, annualPrincipal, firstInterest,
    firstPayment: firstInterest + annualPrincipal, unsecuredCeiling, collateralValue, maxDebt, debtAfter, cashAfter,
  };
}

export function borrow(ctx: Ctx, seat: SeatId, principal: Money, term: number, rateType: 'fixed' | 'floating', collateral: Pledge[]): void {
  const s = ctx.s;
  assertMoney(principal, 'Principal', false);
  if (term !== 3 && term !== 5) reject('bad_term', 'Bank loans run 3 or 5 years.');
  if (rateType !== 'fixed' && rateType !== 'floating') reject('bad_rate_type', 'Choose fixed or floating.');
  if (!Array.isArray(collateral)) reject('bad_collateral', 'Invalid collateral.');
  const q = quoteLoan(s, seat, principal, term, rateType, collateral);
  if (!q.approved) reject('loan_refused', q.reasons[0]);
  const id = newId(ctx, 'L');
  s.loans[id] = {
    id, lender: 'bank', borrower: seat, principal, rate: q.rate, rateType, spread: q.spread, originatedRound: s.round,
    maturityRound: s.round + term - 1, annualPrincipal: q.annualPrincipal, accruedInterest: 0, arrears: 0,
    collateral: collateral.map((c) => ({ ...c })), status: 'current',
  };
  pay(ctx, 'bank', acct.player(seat), principal, `loan ${id} principal`);
  count(s, seat, 'borrow');
  emit(ctx, 'loan_taken', `${s.players[seat].name} borrowed ${fmtUsd(principal)} at ${(q.rate / 100).toFixed(2)}% ${rateType} for ${term} years.`, { seat, data: { loanId: id, principal, rate: q.rate } });
}

function closeIfPaid(l: Loan): void {
  if (l.principal === 0 && l.arrears === 0) {
    l.status = 'paid';
    l.collateral = [];
  } else if (l.arrears === 0 && l.status === 'delinquent') l.status = l.restructuringId ? 'restructured' : 'current';
}

/** Pay up to `amount` on a loan: arrears first, then principal. Returns cash actually paid. */
export function payLoan(ctx: Ctx, l: Loan, amount: Money, memo: string): Money {
  const toArrears = Math.min(amount, l.arrears);
  const toPrincipal = Math.min(amount - toArrears, l.principal);
  const total = toArrears + toPrincipal;
  if (total > 0) pay(ctx, acct.player(l.borrower), acct.holder(l.lender), total, `${memo} ${l.id}`);
  l.arrears -= toArrears;
  l.principal -= toPrincipal;
  closeIfPaid(l);
  return total;
}

export function repay(ctx: Ctx, seat: SeatId, loanId: string, amount: Money): void {
  const s = ctx.s;
  const l = s.loans[loanId];
  if (!l || l.borrower !== seat || l.status === 'paid') reject('unknown_loan', 'That is not one of your open loans.');
  assertMoney(amount, 'Repayment', false);
  if (amount > l.principal + l.arrears) reject('too_much', 'That is more than you owe on this loan.');
  if (amount > spendable(s, seat)) reject('insufficient_cash', 'Not enough spendable cash.');
  payLoan(ctx, l, amount, 'repay');
  emit(ctx, 'loan_repaid', `${s.players[seat].name} repaid ${fmtUsd(amount)}${l.principal + l.arrears === 0 ? ' and cleared the loan' : ''}.`, { seat, data: { loanId, amount } });
}

export function refinance(ctx: Ctx, seat: SeatId, loanId: string, term: number, rateType: 'fixed' | 'floating'): void {
  const s = ctx.s;
  const old = s.loans[loanId];
  if (!old || old.borrower !== seat || old.status === 'paid' || old.lender !== 'bank') reject('unknown_loan', 'Only your open bank loans can be refinanced.');
  if (term !== 3 && term !== 5) reject('bad_term', 'Bank loans run 3 or 5 years.');
  const payoff = old.principal + old.arrears;
  const fee = mulBps(payoff, 100);
  const q = quoteLoan(s, seat, payoff, term, rateType, [], old);
  if (!q.approved) reject('loan_refused', q.reasons[0]);
  if (spendable(s, seat) < fee) reject('insufficient_cash', `You need ${fmtUsd(fee)} in cash for the 1% refinancing fee.`);
  const collateral = old.collateral;
  pay(ctx, acct.player(seat), 'bank', fee, `refinance fee ${loanId}`);
  old.principal = 0;
  old.arrears = 0;
  old.status = 'paid';
  old.collateral = [];
  const id = newId(ctx, 'L');
  s.loans[id] = {
    id, lender: 'bank', borrower: seat, principal: payoff, rate: q.rate, rateType, spread: q.spread, originatedRound: s.round,
    maturityRound: s.round + term - 1, annualPrincipal: q.annualPrincipal, accruedInterest: 0, arrears: 0, collateral, status: 'current',
  };
  emit(ctx, 'loan_refinanced', `${s.players[seat].name} refinanced ${fmtUsd(payoff)} at ${(q.rate / 100).toFixed(2)}% (${fmtUsd(fee)} fee).`, { seat, data: { loanId: id } });
}

/** Floating loans reprice at each Open: current policy rate + contractual spread. */
export function resetFloating(s: MatchState): void {
  for (const l of activeLoans(s)) if (l.rateType === 'floating' && l.lender === 'bank' && !l.restructuringId) l.rate = clamp(s.macro.rate + l.spread, 400, 1500);
}

function priority(l: Loan): number {
  return l.lender === 'bank' ? (l.collateral.length > 0 ? 0 : 1) : 2;
}

export function loansByPriority(s: MatchState, seat: SeatId): Loan[] {
  return activeLoans(s).filter((l) => l.borrower === seat)
    .sort((a, b) => priority(a) - priority(b) || a.maturityRound - b.maturityRound || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function collateralValue(s: MatchState, l: Loan): Money {
  return l.collateral.reduce((a, c) => a + pledgeValue(s, c), 0);
}

/** Close: settle every player's scheduled debt service. Unpaid amounts become named arrears on the loan. */
export function settleObligations(ctx: Ctx): void {
  const s = ctx.s;
  for (const seat of s.seatOrder) {
    const p = s.players[seat];
    for (const l of loansByPriority(s, seat)) {
      if (l.lender !== 'bank' && l.originatedRound === s.round) continue;
      const svc = loanService(s, l);
      let principalDue = svc.principal;
      if (l.collateral.length > 0) {
        // Margin call: secured principal may not exceed 1.25× collateral value.
        const cap = mulDivFloor(collateralValue(s, l), 125, 100);
        if (l.principal > cap) principalDue = Math.max(principalDue, l.principal - cap);
      }
      const to = acct.holder(l.lender);
      const payInt = Math.min(p.cash, svc.interest);
      pay(ctx, acct.player(seat), to, payInt, `interest ${l.id}`);
      if (l.lender !== 'bank') s.players[l.lender].incomeThisRound += payInt;
      const payArr = Math.min(p.cash, l.arrears);
      pay(ctx, acct.player(seat), to, payArr, `arrears ${l.id}`);
      l.arrears -= payArr;
      const payPri = Math.min(p.cash, principalDue);
      pay(ctx, acct.player(seat), to, payPri, `principal ${l.id}`);
      l.principal -= payPri;
      const unpaidPrincipal = principalDue - payPri;
      l.principal -= unpaidPrincipal;
      l.arrears += svc.interest - payInt + unpaidPrincipal;
      if (l.arrears > 0) {
        l.status = 'delinquent';
        emit(ctx, 'payment_missed', `${p.name} missed ${fmtUsd(l.arrears)} due on a loan.`, { seat, data: { loanId: l.id, arrears: l.arrears } });
      } else closeIfPaid(l);
    }
    if (p.propertyArrears > 0) {
      const x = Math.min(p.cash, p.propertyArrears);
      pay(ctx, acct.player(seat), 'economy', x, 'property arrears');
      p.propertyArrears -= x;
    }
  }
}

export function totalArrears(s: MatchState, seat: SeatId): Money {
  let n = s.players[seat].propertyArrears;
  for (const l of activeLoans(s)) if (l.borrower === seat) n += l.arrears;
  return n;
}

/** Apply spendable cash to outstanding arrears in priority order. */
export function settleArrears(ctx: Ctx, seat: SeatId): void {
  const s = ctx.s;
  const p = s.players[seat];
  for (const l of loansByPriority(s, seat)) {
    if (l.arrears === 0) continue;
    const x = Math.min(Math.max(0, spendable(s, seat)), l.arrears);
    if (x > 0) {
      pay(ctx, acct.player(seat), acct.holder(l.lender), x, `arrears ${l.id}`);
      l.arrears -= x;
    }
    closeIfPaid(l);
  }
  if (p.propertyArrears > 0) {
    const x = Math.min(Math.max(0, spendable(s, seat)), p.propertyArrears);
    pay(ctx, acct.player(seat), 'economy', x, 'property arrears');
    p.propertyArrears -= x;
  }
}

// ---------- distress pricing ----------
export function distressUnitPrice(s: MatchState, companyId: string, units: number): Money {
  const def = defOf(s, companyId);
  if (def.kind === 'public') return mulDivFloor(mulDivFloor(valueCompany(s, companyId).mark * units, 9500, 10_000), 9950, 10_000);
  return mulDivFloor(unitValue(s, companyId, units), 6000, 10_000);
}

export function distressPropertyPrice(s: MatchState, propertyId: string): Money {
  return mulDivFloor(propertyValue(s, propertyId), 6500, 10_000);
}

function forceSellUnits(ctx: Ctx, seat: SeatId, companyId: string, units: number): Money {
  const price = distressUnitPrice(ctx.s, companyId, units);
  moveUnits(ctx, companyId, seat, 'bank', units);
  pay(ctx, 'bank', acct.player(seat), price, `distress sale ${companyId}`);
  position(ctx.s, seat, companyId).received += price;
  return price;
}

function forceSellProperty(ctx: Ctx, seat: SeatId, propertyId: string): Money {
  const price = distressPropertyPrice(ctx.s, propertyId);
  moveTitle(ctx, propertyId, seat, 'bank');
  pay(ctx, 'bank', acct.player(seat), price, `distress sale ${propertyId}`);
  position(ctx.s, seat, propertyId).received += price;
  return price;
}

/**
 * Automatic resolution after the rescue window: sell pledged collateral, then unpledged assets (most liquid value
 * first) until arrears are covered; write down what is still in default by 50% into two-year 0% restructuring debt.
 */
export function restructure(ctx: Ctx, seat: SeatId): void {
  const s = ctx.s;
  const p = s.players[seat];
  // Reservations cannot survive a forced liquidation.
  for (const o of Object.values(s.offers)) if (o.status === 'open' && o.proposer === seat) o.status = 'withdrawn';
  s.listings = s.listings.filter((l) => l.seller !== seat);

  for (const l of loansByPriority(s, seat)) {
    if (l.arrears === 0) continue;
    for (const c of l.collateral) {
      const proceeds = c.kind === 'units' ? forceSellUnits(ctx, seat, c.companyId, Math.min(c.units, unitsOf(s, seat, c.companyId))) : forceSellProperty(ctx, seat, c.propertyId);
      payLoan(ctx, l, Math.min(proceeds, l.arrears + l.principal), 'collateral proceeds');
    }
    l.collateral = [];
  }
  settleArrears(ctx, seat);

  while (totalArrears(s, seat) > 0) {
    const need = totalArrears(s, seat);
    const items: { value: Money; sell: () => void }[] = [];
    for (const def of s.content.companies) {
      const free = availableUnits(s, seat, def.id);
      if (free <= 0) continue;
      const all = distressUnitPrice(s, def.id, free);
      if (all <= 0) continue;
      const units = all <= need ? free : Math.min(free, Math.ceil((need * free) / all) + 1);
      items.push({ value: all, sell: () => void forceSellUnits(ctx, seat, def.id, units) });
    }
    for (const def of s.content.properties) {
      if (s.ownership.titles[def.id] !== seat || propertyPledged(s, def.id)) continue;
      items.push({ value: distressPropertyPrice(s, def.id), sell: () => void forceSellProperty(ctx, seat, def.id) });
    }
    if (items.length === 0) break;
    items.sort((a, b) => b.value - a.value);
    items[0].sell();
    settleArrears(ctx, seat);
  }

  const rid = newId(ctx, 'R');
  let writtenOff = 0;
  for (const l of loansByPriority(s, seat)) {
    if (l.arrears === 0) continue;
    const total = l.principal + l.arrears;
    const keep = Math.ceil(total / 2);
    writtenOff += total - keep;
    Object.assign(l, {
      principal: keep, arrears: 0, rate: 0, spread: 0, rateType: 'fixed', maturityRound: s.round + 2, annualPrincipal: Math.ceil(keep / 2),
      status: 'restructured', restructuringId: rid, collateral: [],
    } satisfies Partial<Loan>);
  }
  if (p.propertyArrears > 0) {
    const keep = Math.ceil(p.propertyArrears / 2);
    writtenOff += p.propertyArrears - keep;
    const id = newId(ctx, 'L');
    s.loans[id] = {
      id, lender: 'bank', borrower: seat, principal: keep, rate: 0, rateType: 'fixed', spread: 0, originatedRound: s.round, maturityRound: s.round + 2,
      annualPrincipal: Math.ceil(keep / 2), accruedInterest: 0, arrears: 0, collateral: [], status: 'restructured', restructuringId: rid,
    };
    p.propertyArrears = 0;
  }
  addRep(ctx, seat, -20);
  p.freezeUntil = s.round + 3; // frozen for the next two rounds
  count(s, seat, 'restructure');
  emit(ctx, 'restructured', `${p.name} was restructured${writtenOff > 0 ? `: ${fmtUsd(writtenOff)} of debt written off, the rest due over two years at 0%` : ''}. Reputation −20; bank credit frozen for two years.`, { seat, data: { writtenOff, restructuringId: rid } });

  const v = valuePortfolio(s, seat);
  if (p.cash === 0 && v.publicShares + v.privateEquity + v.property === 0 && p.grants === 0) {
    pay(ctx, 'bank', acct.player(seat), RESTART_GRANT, 'restart grant');
    p.grants += RESTART_GRANT;
    emit(ctx, 'restart_grant', `The bank handed ${p.name} a one-time ${fmtUsd(RESTART_GRANT)} restart grant. It is deducted from the final score.`, { seat });
  }
}

export function validatePlayerLoanTerms(principal: Money, rate: Bps, term: number): void {
  assertMoney(principal, 'Principal', false);
  assertInt(rate, 'Rate', 0, 2000);
  assertInt(term, 'Term', 1, 5);
}
