// Round loop: Open/news -> turns -> deals -> business results -> obligations/distress -> close/report.
import { AP_PER_TURN, type Ctx, acct, activeLoans, addRep, defOf, emit, pay, position, propDefOf, seatsSorted, spendable, unitsOf } from './core';
import { auctionNextSeat, resolveAuction, resolveTender, revealAuction, tenderNextSeat } from './deals';
import { resetFloating, restructure, settleArrears, settleObligations, totalArrears } from './loans';
import { applyOpenMacro, drawNews } from './macro';
import { clamp, distribute, divRound, fmtUsd, mulBps, mulDivFloor } from './money';
import { randInt } from './rng';
import {
  cashInterestRate, currentMargin, effectivePayout, forecastGrowth, holdersOf, modifierSum, propertyNOI, propertyValue, unitValue, valuePortfolio,
} from './valuation';
import type { MatchState, Money, Prompt, Result, ResultRow, SeatId } from './types';

export function openRound(ctx: Ctx): void {
  const s = ctx.s;
  s.phase = 'open';
  applyOpenMacro(ctx);
  resetFloating(s);
  s.flow = {};
  s.startIndex = (s.round - 1) % s.seatOrder.length;
  for (const p of Object.values(s.players)) {
    p.proposalsThisRound = 0;
    p.incomeThisRound = 0;
    p.research = p.research.filter((r) => r.expiresRound >= s.round);
  }
  revealAuction(ctx);
  for (const l of activeLoans(s)) {
    if (l.maturityRound === s.round && l.principal > 0) emit(ctx, 'maturity_notice', `A loan of ${fmtUsd(l.principal)} matures at this year's close.`, { seat: l.borrower, visibleTo: [l.borrower], data: { loanId: l.id } });
  }
  for (const p of Object.values(s.players)) p.minCash = Math.max(0, spendable(s, p.id));
  s.phase = 'turns';
  s.turnIndex = 0;
  s.activeSeat = s.seatOrder[s.startIndex];
  s.apRemaining = AP_PER_TURN;
}

export function endTurn(ctx: Ctx): void {
  const s = ctx.s;
  s.turnIndex += 1;
  if (s.turnIndex < s.seatOrder.length) {
    s.activeSeat = s.seatOrder[(s.startIndex + s.turnIndex) % s.seatOrder.length];
    s.apRemaining = AP_PER_TURN;
    return;
  }
  s.phase = 'deals';
  s.apRemaining = 0;
  advance(ctx);
}

/** Who must act now. 'none' means the engine can advance automatically. */
export function currentPrompt(s: MatchState): Prompt {
  if (s.phase === 'turns') return { kind: 'turn', seat: s.activeSeat };
  if (s.phase === 'deals' || s.phase === 'distress') {
    const open = Object.values(s.offers).filter((o) => o.status === 'open').sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    if (open.length > 0) return { kind: 'offer', seat: open[0].recipient, offerId: open[0].id };
  }
  if (s.phase === 'deals') {
    const t = tenderNextSeat(s);
    if (t) return { kind: 'tender', seat: t };
    if (s.tender) return { kind: 'none' };
    const a = auctionNextSeat(s);
    if (a) return { kind: 'auction', seat: a };
  }
  if (s.phase === 'distress' && s.distress && s.distress.queue.length > 0) return { kind: 'rescue', seat: s.distress.queue[0] };
  return { kind: 'none' };
}

/** Run automatic steps until a seat must act or the match is finished. */
export function advance(ctx: Ctx): void {
  const s = ctx.s;
  for (let guard = 0; guard < 1000; guard++) {
    if (s.phase === 'finished' || s.phase === 'turns') return;
    const prompt = currentPrompt(s);
    if (prompt.kind !== 'none') {
      s.activeSeat = prompt.seat;
      return;
    }
    if (s.phase === 'deals') {
      if (s.tender) {
        resolveTender(ctx);
        continue;
      }
      if (s.auction) resolveAuction(ctx);
      for (const o of Object.values(s.offers)) if (o.status === 'open') o.status = 'expired';
      s.phase = 'earnings';
      businessResults(ctx);
      settleObligations(ctx);
      const queue = s.seatOrder.filter((seat) => totalArrears(s, seat) > 0);
      if (queue.length > 0) {
        s.phase = 'distress';
        s.distress = { queue, decisionsLeft: 3 };
        for (const seat of queue) emit(ctx, 'distress_entered', `${s.players[seat].name} cannot meet ${fmtUsd(totalArrears(s, seat))} of obligations and enters a rescue window.`, { seat });
        continue;
      }
      s.phase = 'close';
    } else if (s.phase === 'distress') {
      s.distress = null;
      s.phase = 'close';
    }
    if (s.phase === 'close') closeRound(ctx);
  }
  throw new Error('invariant: phase advance did not settle');
}

/** A rescue decision was used: settle what cash allows, then leave the window, continue, or restructure. */
export function afterRescueDecision(ctx: Ctx, seat: SeatId, forceRestructure: boolean): void {
  const s = ctx.s;
  const d = s.distress;
  if (!d || d.queue[0] !== seat) return;
  settleArrears(ctx, seat);
  d.decisionsLeft -= 1;
  const cleared = totalArrears(s, seat) === 0;
  const waitingOnOffer = Object.values(s.offers).some((o) => o.status === 'open' && o.proposer === seat);
  if (!cleared && !forceRestructure && (d.decisionsLeft > 0 || waitingOnOffer)) return;
  finishRescue(ctx, seat, cleared);
}

export function finishRescue(ctx: Ctx, seat: SeatId, cleared: boolean): void {
  const s = ctx.s;
  const d = s.distress;
  if (!d) return;
  if (cleared) emit(ctx, 'distress_resolved', `${s.players[seat].name} covered what was due and left the rescue window.`, { seat });
  else restructure(ctx, seat);
  d.queue.shift();
  d.decisionsLeft = 3;
}

/** After an offer response during a rescue: re-settle and close the window if the rescue is out of decisions. */
export function afterRescueResponse(ctx: Ctx): void {
  const s = ctx.s;
  const d = s.distress;
  if (!d || d.queue.length === 0) return;
  const seat = d.queue[0];
  settleArrears(ctx, seat);
  const cleared = totalArrears(s, seat) === 0;
  const waiting = Object.values(s.offers).some((o) => o.status === 'open' && o.proposer === seat);
  if (cleared || (d.decisionsLeft <= 0 && !waiting)) finishRescue(ctx, seat, cleared);
}

function income(s: MatchState, seat: SeatId, assetId: string | null, amount: Money): void {
  s.players[seat].incomeThisRound += amount;
  if (assetId) position(s, seat, assetId).income += amount;
}

/** Close step 4: company and business earnings, corporate debt, dividends, rents and cash interest. Applied once. */
export function businessResults(ctx: Ctx): void {
  const s = ctx.s;
  const earners = new Set<SeatId>();
  for (const def of [...s.content.companies].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const co = s.companies[def.id];
    const shock = randInt(s.rng[`company:${def.id}`], -100 * def.risk, 100 * def.risk);
    const growth = clamp(forecastGrowth(s, def.id).total + s.hidden.sectorDemand[def.sector] + shock, -3000, 3000);
    co.revenue = Math.max(0, co.revenue + mulBps(co.revenue, growth));
    const margin = currentMargin(s, def.id).total;
    const ebit = mulBps(co.revenue, margin);
    co.lastGrowth = growth;
    co.lastMargin = margin;
    co.lastEBIT = ebit;
    pay(ctx, 'economy', acct.company(def.id), ebit, `operating profit ${def.id}`);

    // Corporate obligations come before any payout. Unpaid amounts become corporate arrears.
    const interest = mulBps(co.debt, co.debtRate);
    const payArr = Math.min(co.cash, co.arrears);
    pay(ctx, acct.company(def.id), 'bank', payArr, `corporate arrears ${def.id}`);
    co.arrears -= payArr;
    const payInt = Math.min(co.cash, interest);
    pay(ctx, acct.company(def.id), 'bank', payInt, `corporate interest ${def.id}`);
    co.arrears += interest - payInt;
    if (co.debtMaturity !== null && s.round >= co.debtMaturity && co.debt > 0) {
      const payPri = Math.min(co.cash, co.debt);
      pay(ctx, acct.company(def.id), 'bank', payPri, `corporate principal ${def.id}`);
      co.arrears += co.debt - payPri;
      co.debt = 0;
      co.debtMaturity = null;
    }
    const net = ebit - interest;
    co.lastNet = net;

    let dividend = 0;
    if (co.arrears === 0 && net > 0) dividend = Math.min(mulBps(net, effectivePayout(s, def.id)), co.cash);
    co.lastDividend = dividend;
    if (dividend > 0) {
      const holders = holdersOf(s, def.id);
      const parts = distribute(dividend, s.ownership.units[def.id], holders);
      for (const h of holders) {
        const amt = parts[h] ?? 0;
        if (amt <= 0) continue;
        pay(ctx, acct.company(def.id), acct.holder(h), amt, `dividend ${def.id}`);
        if (h !== 'bank') income(s, h, def.id, amt);
      }
      // Dividend rights redirect part of the seller's actual dividend, once. No dividend, no payment.
      for (const c of s.contracts) {
        if (c.companyId !== def.id) continue;
        const redirect = mulDivFloor(parts[c.seller] ?? 0, c.bps, 10_000);
        c.trailing = redirect;
        if (redirect > 0) {
          pay(ctx, acct.player(c.seller), acct.player(c.buyer), redirect, `dividend rights ${c.id}`);
          income(s, c.seller, null, -redirect);
          income(s, c.buyer, null, redirect);
        }
      }
    } else for (const c of s.contracts) if (c.companyId === def.id) c.trailing = 0;
    const ctrl = s.control[def.id];
    if (ctrl && net > 0 && co.arrears === 0) earners.add(ctrl);
    co.boost = co.pendingBoost;
    co.pendingBoost = 0;
    emit(ctx, 'company_results', `${def.name}: revenue ${fmtUsd(co.revenue)} (${growth >= 0 ? '+' : ''}${(growth / 100).toFixed(1)}%), profit ${fmtUsd(ebit)}, dividends ${fmtUsd(dividend)}.`, { data: { companyId: def.id, growth, shock, sectorDemand: s.hidden.sectorDemand[def.sector] } });
  }
  for (const c of s.contracts) c.roundsLeft -= 1;
  s.contracts = s.contracts.filter((c) => c.roundsLeft > 0);
  for (const seat of seatsSorted(s)) {
    const p = s.players[seat];
    if (earners.has(seat) && p.repCompanyRound !== s.round) {
      p.repCompanyRound = s.round;
      addRep(ctx, seat, 2);
    }
  }

  const rentGrowth = clamp(s.macro.inflation + divRound(s.macro.gdp, 2), -500, 800);
  for (const def of [...s.content.properties].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const pr = s.properties[def.id];
    pr.occupancy = clamp(def.occupancy + (s.macro.confidence - 50) * 20 + divRound(s.macro.gdp, 4) + modifierSum(s, 'occupancy', ['property:all', `property:${def.id}`]), 5000, 9800);
    pr.grossRent += mulBps(pr.grossRent, rentGrowth);
    pr.expense += mulBps(pr.expense, s.macro.inflation);
    const noi = propertyNOI(s, def.id);
    pr.lastNOI = noi;
    const owner = s.ownership.titles[def.id];
    if (owner === 'bank') continue;
    const p = s.players[owner];
    if (noi >= 0) pay(ctx, 'economy', acct.player(owner), noi, `rent ${def.id}`);
    else {
      const x = Math.min(p.cash, -noi);
      pay(ctx, acct.player(owner), 'economy', x, `property costs ${def.id}`);
      p.propertyArrears += -noi - x;
    }
    income(s, owner, def.id, noi);
  }

  const rate = cashInterestRate(s);
  for (const seat of seatsSorted(s)) {
    const p = s.players[seat];
    const interest = mulBps(Math.min(p.minCash, p.cash), rate);
    pay(ctx, 'bank', acct.player(seat), interest, 'cash interest');
    income(s, seat, null, interest);
  }
}

function closeRound(ctx: Ctx): void {
  const s = ctx.s;
  for (const m of s.modifiers) m.roundsLeft -= 1;
  s.modifiers = s.modifiers.filter((m) => m.roundsLeft > 0);
  for (const seat of s.seatOrder) {
    const p = s.players[seat];
    const v = valuePortfolio(s, seat);
    p.lastIncome = p.incomeThisRound;
    p.history.push({ round: s.round, netWorth: v.netWorth, debt: v.liabilities, income: p.incomeThisRound, cash: p.cash });
  }
  emit(ctx, 'round_closed', `Year ${s.round} closed.`);
  if (s.round >= s.totalRounds) {
    s.listings = [];
    s.phase = 'finished';
    s.result = computeResult(s);
    const names = s.result.winners.map((w) => s.players[w].name).join(' and ');
    emit(ctx, 'match_finished', `${names} ${s.result.winners.length > 1 ? 'share the win' : 'wins'}.`);
    return;
  }
  drawNews(ctx, s.round + 1);
  s.round += 1;
  openRound(ctx);
}

function personality(counts: Record<string, number>, levPeak: boolean): string {
  const c = (k: string) => counts[k] ?? 0;
  if (c('restructure') > 0) return 'The Phoenix';
  if (c('tender') > 0 || c('policy') + c('reinvest') >= 3) return 'The Raider';
  if (c('borrow') >= 3 || levPeak) return 'The Leverage Artist';
  if (c('buyProperty') + c('upgrade') >= 3) return 'The Landlord';
  if (c('dealDone') >= 3) return 'The Dealmaker';
  if (c('buyStock') + c('sellStock') >= 10) return 'The Trader';
  if (c('buyStock') + c('buyBusiness') + c('buyProperty') <= 1) return 'The Mattress Stuffer';
  return 'The Steady Hand';
}

export function assetValueHeld(s: MatchState, seat: SeatId, assetId: string): Money {
  if (s.companies[assetId]) return unitValue(s, assetId, unitsOf(s, seat, assetId));
  return s.ownership.titles[assetId] === seat ? propertyValue(s, assetId) : 0;
}

export function assetName(s: MatchState, assetId: string): string {
  return s.companies[assetId] ? defOf(s, assetId).name : propDefOf(s, assetId).name;
}

export function computeResult(s: MatchState): Result {
  const rows: ResultRow[] = s.seatOrder.map((seat) => {
    const v = valuePortfolio(s, seat);
    const p = s.players[seat];
    const gains = Object.entries(p.positions)
      .filter(([, pos]) => pos.spent > 0)
      .map(([assetId, pos]) => {
        const held = assetValueHeld(s, seat, assetId);
        return { assetId, gain: pos.received + pos.income + held - pos.spent, realized: held === 0 };
      })
      .sort((a, b) => b.gain - a.gain || (a.assetId < b.assetId ? -1 : 1));
    const levPeak = p.history.some((h) => h.debt * 2 > h.netWorth + h.debt && h.debt > 0);
    return {
      seat, netWorth: v.netWorth, grants: v.grants, bonus: v.bonus, adjusted: v.adjusted, debt: v.liabilities, rank: 0,
      label: personality(p.actionCounts, levPeak), best: gains[0], worst: gains.length > 1 ? gains[gains.length - 1] : undefined,
    };
  });
  const cmp = (a: ResultRow, b: ResultRow) => b.adjusted - a.adjusted || b.netWorth - a.netWorth || a.debt - b.debt;
  const sorted = [...rows].sort(cmp);
  sorted.forEach((r, i) => (r.rank = i > 0 && cmp(sorted[i - 1], r) === 0 ? sorted[i - 1].rank : i + 1));
  return { rows: sorted, winners: sorted.filter((r) => r.rank === 1).map((r) => r.seat) };
}
