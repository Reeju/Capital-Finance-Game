import { describe, expect, it } from 'vitest';
import {
  type MatchState, MAX_SINGLE, applyCommand, auditState, availableUnits, capRate, contractValue, currentPrompt, distribute, envelope, getObservation, minBid, minTenderPrice,
  mulBps, mulDiv, propertyNOI, propertyValue, quoteLoan, quoteMarket, reservedCash, spendable, stateHash, totalArrears, unitsOf, valueCompany,
  valuePortfolio,
} from '../index';
import { act, promptSeat, giveUnits, goTo, newMatch, passOnce, passUntil, patch, toRound, toTurnOf, tryAct } from './helpers';

const initialMacro = (s: MatchState) => patch(s, (d) => Object.assign(d.macro, { gdp: 210, inflation: 240, rate: 400, confidence: 55, credit: 40, commodity: 100, sentiment: 10_000 }));

describe('integer money', () => {
  it('rounds half away from zero and survives large products', () => {
    expect(mulBps(5, 5000)).toBe(3);
    expect(mulBps(-5, 5000)).toBe(-3);
    expect(mulBps(3, 3333)).toBe(1);
    expect(mulDiv(MAX_SINGLE, 140_000, 10_000)).toBe(MAX_SINGLE * 14);
  });
  it('distributes pro rata with the residual to the first holder, bank last', () => {
    const out = distribute(100, { a: 1, b: 1, bank: 1 }, ['a', 'b', 'bank']);
    expect(out).toEqual({ a: 34, b: 33, bank: 33 });
  });
  it('rejects amounts over the $10 billion limit', () => {
    const s = toTurnOf(newMatch(), 'p1');
    const r = tryAct(s, 'p1', { type: 'Repay', loanId: 'L1', amount: MAX_SINGLE + 1 });
    expect(r.ok).toBe(false);
  });
});

describe('turns, AP and the district graph', () => {
  it('starts everyone in Financial with 3 AP and rotates the starting seat each round', () => {
    let s = newMatch(3);
    expect(s.activeSeat).toBe('p1');
    expect(s.apRemaining).toBe(3);
    expect(Object.values(s.players).every((p) => p.district === 'financial' && p.cash === 500_000_00)).toBe(true);
    s = toRound(s, 2);
    expect(s.activeSeat).toBe('p2');
    s = toRound(s, 3);
    expect(s.activeSeat).toBe('p3');
  });
  it('enforces adjacency, location and AP', () => {
    let s = newMatch();
    expect(tryAct(s, 'p1', { type: 'Move', to: 'tech' }).error?.code).toBe('not_adjacent');
    expect(tryAct(s, 'p1', { type: 'MarketOrder', companyId: 'byte', shares: 10 }).error?.code).toBe('wrong_district');
    expect(tryAct(s, 'p2', { type: 'EndTurn' }).error?.code).toBe('not_your_turn');
    s = goTo(s, 'p1', ['wallstreet', 'tech', 'industrial']);
    expect(s.apRemaining).toBe(0);
    expect(tryAct(s, 'p1', { type: 'Move', to: 'energy' }).error?.code).toBe('no_ap');
    s = act(s, 'p1', { type: 'EndTurn' });
    expect(s.activeSeat).toBe('p2');
  });
  it('rejections change nothing: same object, same revision, same RNG', () => {
    const s = newMatch();
    const before = stateHash(s);
    const r = tryAct(s, 'p1', { type: 'Move', to: 'tech' });
    expect(r.ok).toBe(false);
    expect(r.state).toBe(s);
    expect(stateHash(s)).toBe(before);
    // an envelope built for an older revision is refused as stale
    const env = envelope(s, 'p1', { type: 'EndTurn' }, 'dup');
    const next = applyCommand(s, env);
    expect(next.ok).toBe(true);
    expect(applyCommand(next.state, env).error?.code).toBe('stale');
  });
  it('only the system may time a seat out, and a timeout never buys anything', () => {
    const s = newMatch();
    expect(tryAct(s, 'p1', { type: 'TimeoutTurn' }).error?.code).toBe('forbidden');
    const t = act(s, 'system', { type: 'TimeoutTurn' });
    expect(t.activeSeat).toBe('p2');
    expect(t.players.p1.cash).toBe(500_000_00);
  });
});

describe('valuation', () => {
  it('prices property from NOI and cap rate (spec seed values)', () => {
    const s = initialMacro(newMatch());
    expect(capRate(s, 'offices')).toBe(800);
    expect(propertyNOI(patch(s, (d) => { d.properties.offices.occupancy = 9000; }), 'offices')).toBe(26_000_00);
    const seed = patch(s, (d) => { for (const p of d.content.properties) d.properties[p.id].occupancy = p.occupancy; });
    expect(propertyValue(seed, 'offices')).toBe(325_000_00);
    expect(propertyValue(seed, 'hotel')).toBe(233_333_33);
    expect(propertyValue(seed, 'warehouse')).toBe(268_750_00);
    expect(propertyValue(seed, 'apartments')).toBe(320_000_00);
  });
  it('uses EV/EBIT and deducts corporate debt exactly once', () => {
    const s = newMatch();
    const v = valueCompany(s, 'nova');
    const co = s.companies.nova;
    expect(v.ev).toBe(mulDiv(v.normalizedEBIT, v.multipleBps, 10_000));
    expect(v.equity).toBe(v.ev + co.cash - co.debt - co.arrears);
    const held = giveUnits(s, 'p1', 'nova', 10_000);
    const pv = valuePortfolio(held, 'p1');
    expect(pv.publicShares).toBe(valueCompany(held, 'nova').mark * 10_000);
    expect(pv.liabilities).toBe(0); // the company's $140K debt is not the shareholder's liability
  });
  it('a 300bp rate rise cuts the tech multiple by 4.2 turns', () => {
    const s = initialMacro(newMatch());
    const up = patch(s, (d) => { d.macro.rate = 700; });
    expect(valueCompany(s, 'byte').multipleBps - valueCompany(up, 'byte').multipleBps).toBe(42_000);
  });
  it('matches the spec net-worth example without double counting', () => {
    let s = initialMacro(newMatch());
    s = patch(s, (d) => {
      d.players.p1.cash = 200_000_00;
      d.loans.L9 = { id: 'L9', lender: 'p2', borrower: 'p1', principal: 150_000_00, rate: 500, rateType: 'fixed', spread: 0, originatedRound: 1, maturityRound: 4, annualPrincipal: 50_000_00, accruedInterest: 0, arrears: 0, collateral: [], status: 'current' };
    });
    const v = valuePortfolio(s, 'p1');
    expect(v.netWorth).toBe(200_000_00 - 150_000_00);
    expect(valuePortfolio(s, 'p2').receivables).toBe(150_000_00);
  });
});

describe('exchange', () => {
  it('quotes spread plus size impact and never mutates state', () => {
    const s = goTo(newMatch(), 'p1', ['wallstreet']);
    const before = stateHash(s);
    const mark = valueCompany(s, 'mpwr').mark;
    const buy = quoteMarket(s, 'p1', 'mpwr', 1000);
    expect(buy.impactBps).toBe(200);
    expect(buy.total).toBe(Math.ceil((mark * 1000 * 10_250) / 10_000));
    expect(quoteMarket(s, 'p1', 'mpwr', -1000).total).toBe(Math.floor((mark * 1000 * 9750) / 10_000));
    expect(stateHash(s)).toBe(before);
  });
  it('buying then selling at the same marks loses the round trip; marks do not move with flow', () => {
    let s = goTo(newMatch(), 'p1', ['wallstreet']);
    const mark = valueCompany(s, 'mpwr').mark;
    s = act(s, 'p1', { type: 'MarketOrder', companyId: 'mpwr', shares: 500 });
    expect(valueCompany(s, 'mpwr').mark).toBe(mark);
    s = act(s, 'p1', { type: 'MarketOrder', companyId: 'mpwr', shares: -500 });
    expect(s.players.p1.cash).toBeLessThan(500_000_00);
    expect(unitsOf(s, 'p1', 'mpwr')).toBe(0);
  });
  it('limits buys to the bank float and sells to holdings', () => {
    const s = goTo(newMatch(), 'p1', ['wallstreet']);
    expect(tryAct(s, 'p1', { type: 'MarketOrder', companyId: 'mpwr', shares: -1 }).error?.code).toBe('not_owned');
    expect(tryAct(s, 'p1', { type: 'MarketOrder', companyId: 'mpwr', shares: 10_000 }).error?.code).toBe('insufficient_cash');
    expect(tryAct(s, 'p1', { type: 'MarketOrder', companyId: 'cloudforge', shares: 10 }).error?.code).toBe('not_listed');
  });
});

describe('control', () => {
  it('needs strictly more than 50%', () => {
    const s = newMatch();
    expect(giveUnits(s, 'p1', 'byte', 4999).control.byte).toBe(null);
    expect(giveUnits(s, 'p1', 'byte', 5000).control.byte).toBe(null);
    expect(giveUnits(s, 'p1', 'byte', 5001).control.byte).toBe('p1');
  });
  it('lets only the controller set payout, once per round, at the company district', () => {
    let s = giveUnits(newMatch(), 'p1', 'byte', 5001);
    expect(tryAct(s, 'p1', { type: 'SetPolicy', companyId: 'byte', payout: 7500 }).error?.code).toBe('wrong_district');
    s = goTo(s, 'p1', ['wallstreet', 'tech']);
    expect(tryAct(s, 'p1', { type: 'SetPolicy', companyId: 'byte', payout: 6000 }).error?.code).toBe('bad_payout');
    s = act(s, 'p1', { type: 'SetPolicy', companyId: 'byte', payout: 7500 });
    expect(s.companies.byte.payout).toBe(7500);
    s = act(s, 'p1', { type: 'EndTurn' });
    s = toTurnOf(s, 'p1');
    s = act(s, 'p1', { type: 'Reinvest', companyId: 'byte', amount: 10_000_00 });
    expect(tryAct(s, 'p1', { type: 'SetPolicy', companyId: 'byte', payout: 0 }).error?.code).toBe('once_per_round');
    expect(tryAct(giveUnits(newMatch(), 'p1', 'byte', 5000), 'p1', { type: 'SetPolicy', companyId: 'byte', payout: 0 }).ok).toBe(false);
  });
  it('pays dividends pro rata to minority holders and spends reinvestment from company cash', () => {
    let s = giveUnits(giveUnits(newMatch(), 'p1', 'mpwr', 6000), 'p2', 'mpwr', 1000);
    const cash1 = s.players.p1.cash;
    const cash2 = s.players.p2.cash;
    s = toRound(s, 2);
    const d = s.companies.mpwr.lastDividend;
    expect(d).toBeGreaterThan(0);
    const i1 = s.players.p1.positions.mpwr.income;
    const i2 = s.players.p2.positions.mpwr.income;
    expect(i1 + i2).toBeLessThanOrEqual(Math.ceil((d * 7000) / 10_000));
    expect(Math.abs(i1 - i2 * 6)).toBeLessThanOrEqual(6);
    expect(s.players.p1.cash).toBeGreaterThan(cash1);
    expect(s.players.p2.cash).toBeGreaterThan(cash2);
    s = goTo(toTurnOf(s, 'p1'), 'p1', ['industrial', 'energy']);
    const before = s.companies.mpwr.cash;
    s = act(s, 'p1', { type: 'Reinvest', companyId: 'mpwr', amount: 20_000_00 });
    expect(s.companies.mpwr.cash).toBe(before - 20_000_00);
    expect(s.companies.mpwr.pendingBoost).toBeGreaterThan(0);
    expect(s.companies.mpwr.pendingBoost).toBeLessThanOrEqual(800);
    expect(s.players.p1.cash).toBe(toTurnOf(toRound(giveUnits(giveUnits(newMatch(), 'p1', 'mpwr', 6000), 'p2', 'mpwr', 1000), 2), 'p1').players.p1.cash);
  });
});

describe('bank loans', () => {
  it('underwrites on the post-funding balance sheet and refuses over-leverage', () => {
    const s = newMatch();
    const ok = quoteLoan(s, 'p1', 100_000_00, 5, 'fixed', []);
    expect(ok.approved).toBe(true);
    expect(ok.leverageBps).toBe(mulDiv(100_000_00, 10_000, 600_000_00));
    expect(ok.annualPrincipal).toBe(20_000_00);
    expect(quoteLoan(s, 'p1', 5_000_00, 5, 'fixed', []).approved).toBe(false);
    const big = quoteLoan(s, 'p1', 900_000_00, 5, 'fixed', []);
    expect(big.approved).toBe(false);
    expect(tryAct(s, 'p1', { type: 'Borrow', principal: 900_000_00, term: 5, rateType: 'fixed', collateral: [] }).error?.code).toBe('loan_refused');
  });
  it('amortizes annually from the current Close, fixed stays fixed and floating resets', () => {
    let s = newMatch();
    s = act(s, 'p1', { type: 'Borrow', principal: 60_000_00, term: 3, rateType: 'fixed', collateral: [] });
    s = act(s, 'p1', { type: 'Borrow', principal: 50_000_00, term: 5, rateType: 'floating', collateral: [] });
    const [fixed, floating] = Object.values(s.loans);
    const fixedRate = fixed.rate;
    expect(s.players.p1.cash).toBe(610_000_00);
    s = toRound(s, 2);
    expect(s.loans[fixed.id].principal).toBe(40_000_00);
    expect(s.loans[fixed.id].rate).toBe(fixedRate);
    expect(s.loans[floating.id].principal).toBe(40_000_00);
    expect(s.loans[floating.id].rate).toBe(Math.min(1500, Math.max(400, s.macro.rate + floating.spread)));
    s = toRound(s, 4);
    expect(s.loans[fixed.id].status).toBe('paid');
    expect(s.loans[fixed.id].principal).toBe(0);
  });
  it('rejects double pledges and releases collateral on payoff', () => {
    let s = giveUnits(newMatch(), 'p1', 'mpwr', 2000);
    const pledge = [{ kind: 'units' as const, companyId: 'mpwr', units: 2000 }];
    s = act(s, 'p1', { type: 'Borrow', principal: 50_000_00, term: 3, rateType: 'fixed', collateral: pledge });
    expect(availableUnits(s, 'p1', 'mpwr')).toBe(0);
    expect(tryAct(s, 'p1', { type: 'Borrow', principal: 20_000_00, term: 3, rateType: 'fixed', collateral: pledge }).error?.code).toBe('loan_refused');
    const id = Object.keys(s.loans)[0];
    s = act(s, 'p1', { type: 'Repay', loanId: id, amount: 50_000_00 });
    expect(s.loans[id].status).toBe('paid');
    expect(availableUnits(s, 'p1', 'mpwr')).toBe(2000);
  });
  it('refinancing charges 1% and never frees collateral before commit', () => {
    let s = giveUnits(newMatch(), 'p1', 'mpwr', 2000);
    s = act(s, 'p1', { type: 'Borrow', principal: 50_000_00, term: 3, rateType: 'fixed', collateral: [{ kind: 'units', companyId: 'mpwr', units: 2000 }] });
    const id = Object.keys(s.loans)[0];
    const cash = s.players.p1.cash;
    s = act(s, 'p1', { type: 'Refinance', loanId: id, term: 5, rateType: 'floating' });
    expect(s.players.p1.cash).toBe(cash - 500_00);
    const fresh = Object.values(s.loans).find((l) => l.status !== 'paid');
    expect(fresh?.principal).toBe(50_000_00);
    expect(fresh?.collateral).toHaveLength(1);
    expect(availableUnits(s, 'p1', 'mpwr')).toBe(0);
  });
});

function broke(seed = 'test'): MatchState {
  // p1 owes far more than it can pay at the next Close.
  let s = newMatch(2, 12, seed);
  s = patch(s, (d) => {
    d.players.p1.cash = 20_000_00;
    d.economyCash += 480_000_00;
    d.loans.L9 = { id: 'L9', lender: 'bank', borrower: 'p1', principal: 300_000_00, rate: 1000, rateType: 'fixed', spread: 600, originatedRound: 1, maturityRound: 1, annualPrincipal: 300_000_00, accruedInterest: 0, arrears: 0, collateral: [], status: 'current' };
  });
  return s;
}

describe('distress without elimination', () => {
  it('turns a missed payment into named arrears and opens a three-decision rescue window', () => {
    let s = passUntil(broke(), (x) => x.phase === 'distress');
    expect(currentPrompt(s)).toEqual({ kind: 'rescue', seat: 'p1' });
    expect(s.distress?.decisionsLeft).toBe(3);
    expect(s.players.p1.cash).toBe(0);
    const l = s.loans.L9;
    expect(l.status).toBe('delinquent');
    expect(l.principal).toBe(0);
    expect(l.arrears).toBeGreaterThan(300_000_00);
    expect(l.arrears).toBeLessThan(330_000_00);
    expect(tryAct(s, 'p1', { type: 'Move', to: 'wallstreet' }).error?.code).toBe('rescue_only');
    s = act(s, 'p1', { type: 'Restructure' });
    expect(s.phase).not.toBe('distress');
  });
  it('writes debt down once, freezes credit, costs 20 reputation and grants exactly one restart', () => {
    let s = passUntil(broke(), (x) => x.phase === 'distress');
    const owed = s.loans.L9.principal + s.loans.L9.arrears;
    s = act(s, 'p1', { type: 'Restructure' });
    const l = s.loans.L9;
    expect(l.status).toBe('restructured');
    expect(l.principal).toBe(Math.ceil(owed / 2));
    expect(l.rate).toBe(0);
    expect(l.restructuringId).toBeTruthy();
    expect(s.players.p1.reputation).toBe(40);
    expect(s.players.p1.grants).toBe(50_000_00);
    expect(s.players.p1.cash).toBeGreaterThanOrEqual(50_000_00);
    expect(quoteLoan(s, 'p1', 10_000_00, 3, 'fixed', []).approved).toBe(false);
    // The seat keeps playing; a second collapse has no grant and still no elimination.
    s = toTurnOf(s, 'p1');
    expect(s.apRemaining).toBe(3);
    s = patch(s, (d) => { d.economyCash += d.players.p1.cash; d.players.p1.cash = 0; });
    s = passUntil(s, (x) => x.phase === 'distress' || x.round > 4);
    if (s.phase === 'distress') s = act(s, 'p1', { type: 'Restructure' });
    expect(s.players.p1.grants).toBe(50_000_00);
    s = toTurnOf(s, 'p1');
    expect(s.seatOrder).toContain('p1');
    expect(valuePortfolio(s, 'p1').adjusted).toBe(valuePortfolio(s, 'p1').netWorth - 50_000_00 + s.players.p1.reputation * 100_00);
  });
  it('sells pledged collateral first in the automatic resolution', () => {
    let s = giveUnits(broke(), 'p1', 'mpwr', 3000);
    s = patch(s, (d) => { d.loans.L9.collateral = [{ kind: 'units', companyId: 'mpwr', units: 3000 }]; });
    s = passUntil(s, (x) => x.phase === 'distress');
    s = act(s, 'system', { type: 'TimeoutTurn' });
    expect(unitsOf(s, 'p1', 'mpwr')).toBe(0);
    expect(totalArrears(s, 'p1')).toBe(0);
    expect(auditState(s).ok).toBe(true);
  });
  it('lets a rival buy assets cheaply in a rescue deal', () => {
    let s = giveUnits(broke(), 'p1', 'mpwr', 6000);
    s = passUntil(s, (x) => x.phase === 'distress');
    const due = totalArrears(s, 'p1');
    s = act(s, 'p1', { type: 'ProposeTrade', recipient: 'p2', give: { cash: 0, units: { mpwr: 6000 }, properties: [] }, receive: { cash: due, units: {}, properties: [] } });
    expect(currentPrompt(s).kind).toBe('offer');
    s = act(s, 'p2', { type: 'AcceptOffer', offerId: Object.keys(s.offers)[0] });
    expect(unitsOf(s, 'p2', 'mpwr')).toBe(6000);
    expect(s.control.mpwr).toBe('p2');
    expect(s.players.p1.reputation).toBe(62); // no restructuring penalty; +2 for the profitable company it controlled at Close
    expect(s.loans.L9.status).toBe('paid');
  });
});

describe('offers and contracts', () => {
  it('reserves the proposer\'s side, settles atomically and caps open proposals', () => {
    let s = giveUnits(newMatch(), 'p1', 'byte', 1000);
    s = act(s, 'p1', { type: 'ProposeTrade', recipient: 'p2', give: { cash: 0, units: { byte: 1000 }, properties: [] }, receive: { cash: 50_000_00, units: {}, properties: [] } });
    expect(availableUnits(s, 'p1', 'byte')).toBe(0);
    s = act(s, 'p1', { type: 'ProposeTrade', recipient: 'p2', give: { cash: 100_000_00, units: {}, properties: [] }, receive: { cash: 0, units: {}, properties: [] } });
    expect(reservedCash(s, 'p1')).toBe(100_000_00);
    expect(spendable(s, 'p1')).toBe(400_000_00);
    expect(tryAct(s, 'p1', { type: 'ProposeTrade', recipient: 'p2', give: { cash: 1, units: {}, properties: [] }, receive: { cash: 0, units: {}, properties: [] } }).error?.code).toBe('too_many_open');
    s = passUntil(s, (x) => x.phase === 'deals');
    const [first, gift] = Object.keys(s.offers);
    expect(tryAct(s, 'p2', { type: 'PassAuction' }).error?.code).toBe('respond_first');
    s = act(s, 'p2', { type: 'AcceptOffer', offerId: first });
    expect(unitsOf(s, 'p2', 'byte')).toBe(1000);
    s = act(s, 'p2', { type: 'AcceptOffer', offerId: gift });
    expect(s.players.p2.cash).toBe(500_000_00 - 50_000_00 + 100_000_00);
    expect(s.players.p2.reputation).toBe(60); // gifts and spot trades earn no reputation
  });
  it('rejects acceptance when inventory changed, without partial settlement, and expires at round end', () => {
    let s = giveUnits(newMatch(), 'p2', 'byte', 1000);
    s = act(s, 'p1', { type: 'ProposeTrade', recipient: 'p2', give: { cash: 10_000_00, units: {}, properties: [] }, receive: { cash: 0, units: { byte: 1000 }, properties: [] } });
    s = passUntil(s, (x) => x.phase === 'deals');
    const raced = giveUnits(patch(s, (d) => { d.ownership.units.byte.p2 = 0; d.ownership.units.byte.bank += 1000; }), 'p1', 'byte', 0);
    const r = tryAct(raced, 'p2', { type: 'AcceptOffer', offerId: Object.keys(s.offers)[0] });
    expect(r.error?.code).toBe('not_owned');
    expect(r.state.players.p1.cash).toBe(500_000_00);
    s = toRound(s, 2);
    expect(Object.values(s.offers)[0].status).toBe('rejected');
    s = act(s, s.activeSeat, { type: 'ProposeTrade', recipient: s.activeSeat === 'p1' ? 'p2' : 'p1', give: { cash: 1_00, units: {}, properties: [] }, receive: { cash: 0, units: {}, properties: [] } });
    s = act(s, 'system', { type: 'TimeoutTurn' });
    s = passUntil(s, (x) => x.phase === 'deals' && currentPrompt(x).kind !== 'offer' || x.round === 3);
    expect(reservedCash(s, 'p1') + reservedCash(s, 'p2')).toBeLessThanOrEqual(s.auction?.highBid ?? 0);
  });
  it('enforces player loans and counts them once on each balance sheet', () => {
    let s = newMatch();
    s = act(s, 'p1', { type: 'ProposeLoan', recipient: 'p2', role: 'lender', principal: 100_000_00, rate: 1000, term: 2, collateral: [] });
    s = passUntil(s, (x) => x.phase === 'deals');
    s = act(s, 'p2', { type: 'AcceptOffer', offerId: Object.keys(s.offers)[0] });
    expect(s.players.p2.cash).toBe(600_000_00);
    expect(valuePortfolio(s, 'p1').receivables).toBe(100_000_00);
    expect(valuePortfolio(s, 'p2').liabilities).toBe(100_000_00);
    expect(s.players.p1.reputation).toBe(61);
    s = toRound(s, 3);
    const l = Object.values(s.loans)[0];
    expect(l.principal).toBe(50_000_00);
    s = toRound(s, 4);
    expect(Object.values(s.loans)[0].status).toBe('paid');
  });
  it('redirects only actual dividends under dividend rights and never double counts their value', () => {
    let s = giveUnits(newMatch(), 'p1', 'mpwr', 4000);
    s = act(s, 'p1', { type: 'ProposeRights', recipient: 'p2', role: 'seller', companyId: 'mpwr', bps: 5000, rounds: 2, price: 10_000_00 });
    s = passUntil(s, (x) => x.phase === 'deals');
    const total = valuePortfolio(s, 'p1').netWorth + valuePortfolio(s, 'p2').netWorth;
    s = act(s, 'p2', { type: 'AcceptOffer', offerId: Object.keys(s.offers)[0] });
    expect(valuePortfolio(s, 'p1').netWorth + valuePortfolio(s, 'p2').netWorth).toBe(total);
    expect(contractValue(s, s.contracts[0])).toBeGreaterThan(0);
    expect(availableUnits(s, 'p1', 'mpwr')).toBe(0);
    s = toRound(s, 2);
    const sellerIncome = s.players.p1.positions.mpwr.income;
    expect(s.contracts[0].trailing).toBe(Math.floor(sellerIncome / 2));
    expect(s.contracts[0].roundsLeft).toBe(1);
    s = toRound(s, 3);
    expect(s.contracts).toHaveLength(0);
    expect(availableUnits(s, 'p1', 'mpwr')).toBe(4000);
  });
});

describe('auction', () => {
  it('escrows the high bid, releases the outbid bidder and transfers title to the last bidder standing', () => {
    let s = passUntil(newMatch(3), (x) => x.phase === 'deals');
    const a = s.auction;
    expect(a).toBeTruthy();
    const first = promptSeat(s);
    const need = minBid(s);
    expect(tryAct(s, first, { type: 'Bid', amount: need - 1 }).error?.code).toBe('bid_too_low');
    expect(tryAct(s, first, { type: 'Bid', amount: 600_000_00 }).error?.code).toBe('insufficient_cash');
    s = act(s, first, { type: 'Bid', amount: need });
    expect(reservedCash(s, first)).toBe(need);
    const second = promptSeat(s);
    s = act(s, second, { type: 'Bid', amount: need + 5_000_00 });
    expect(reservedCash(s, first)).toBe(0);
    s = passOnce(s); // third seat passes
    s = passOnce(s); // first passes
    expect(s.players[second].cash).toBeLessThan(500_000_00);
    expect(s.auction === null || s.auction.id !== a?.id).toBe(true);
    const won = a?.asset.kind === 'property' ? s.ownership.titles[a.asset.propertyId] === second : unitsOf(s, second, a?.asset.kind === 'units' ? a.asset.companyId : '') === 10_000;
    expect(won).toBe(true);
  });
  it('leaves the bank asset unchanged when nobody bids', () => {
    const s0 = passUntil(newMatch(), (x) => x.phase === 'deals');
    const a = s0.auction;
    const s = toRound(s0, 2);
    if (a?.asset.kind === 'property') expect(s.ownership.titles[a.asset.propertyId]).toBe('bank');
    expect(s.auction?.id).not.toBe(a?.id);
  });
});

describe('tender offers', () => {
  const setup = () => {
    let s = giveUnits(giveUnits(newMatch(3), 'p1', 'mpwr', 2000), 'p2', 'mpwr', 7000);
    s = patch(s, (d) => { d.ownership.units.mpwr.p3 = 1000; d.ownership.units.mpwr.bank = 0; });
    return goTo(s, 'p1', ['wallstreet']);
  };
  it('requires a 110% price and full cash escrow', () => {
    const s = setup();
    const min = minTenderPrice(s, 'mpwr');
    expect(tryAct(s, 'p1', { type: 'Tender', companyId: 'mpwr', price: min - 1, maxShares: 100, minShares: 100 }).error?.code).toBe('price_too_low');
    expect(tryAct(s, 'p1', { type: 'Tender', companyId: 'mpwr', price: min, maxShares: 8000, minShares: 100 }).error?.code).toBe('insufficient_cash');
    const t = act(s, 'p1', { type: 'Tender', companyId: 'mpwr', price: min, maxShares: 3001, minShares: 3001 });
    expect(reservedCash(t, 'p1')).toBe(min * 3001);
  });
  it('refunds escrow and costs 5 reputation when too few shares come in', () => {
    let s = setup();
    s = act(s, 'p1', { type: 'Tender', companyId: 'mpwr', price: minTenderPrice(s, 'mpwr'), maxShares: 3001, minShares: 3001 });
    s = passUntil(s, (x) => currentPrompt(x).kind === 'tender');
    s = act(s, 'p2', { type: 'TenderResponse', shares: 500 });
    s = act(s, 'p3', { type: 'TenderResponse', shares: 0 });
    expect(s.tender).toBe(null);
    expect(s.players.p1.reputation).toBe(55);
    expect(unitsOf(s, 'p1', 'mpwr')).toBe(2000);
    expect(reservedCash(s, 'p1')).toBe(s.auction?.highBidder === 'p1' ? s.auction.highBid : 0);
  });
  it('fills pro rata up to the maximum and pays only for executed shares', () => {
    let s = setup();
    const price = minTenderPrice(s, 'mpwr');
    s = act(s, 'p1', { type: 'Tender', companyId: 'mpwr', price, maxShares: 3001, minShares: 3001 });
    const cash = s.players.p1.cash;
    s = passUntil(s, (x) => currentPrompt(x).kind === 'tender');
    s = act(s, 'p2', { type: 'TenderResponse', shares: 7000 });
    s = act(s, 'p3', { type: 'TenderResponse', shares: 1000 });
    expect(unitsOf(s, 'p1', 'mpwr')).toBe(5001);
    expect(s.control.mpwr).toBe('p1');
    expect(unitsOf(s, 'p2', 'mpwr')).toBe(7000 - 2626);
    expect(unitsOf(s, 'p3', 'mpwr')).toBe(1000 - 375);
    expect(s.players.p1.cash).toBe(cash - price * 3001);
    // the tender premium is not a new market mark
    expect(valueCompany(s, 'mpwr').mark).toBeLessThan(price);
  });
});

describe('assets', () => {
  it('sells posted businesses and property at 105% and buys back at a liquidity discount', () => {
    let s = goTo(newMatch(), 'p1', ['realestate']);
    const target = s.content.properties.find((p) => p.district === 'realestate' && !(s.auction?.asset.kind === 'property' && s.auction.asset.propertyId === p.id));
    if (!target) throw new Error('no property');
    const fair = propertyValue(s, target.id);
    s = act(s, 'p1', { type: 'BuyAsset', asset: { kind: 'property', propertyId: target.id } });
    expect(s.players.p1.cash).toBe(500_000_00 - Math.ceil((fair * 10_500) / 10_000));
    expect(valuePortfolio(s, 'p1').property).toBe(fair);
    const upgraded = act(s, 'p1', { type: 'Upgrade', propertyId: target.id });
    expect(upgraded.properties[target.id].grossRent).toBe(s.properties[target.id].grossRent + 4_000_00);
    s = act(s, 'p1', { type: 'SellAsset', asset: { kind: 'property', propertyId: target.id } });
    expect(s.players.p1.cash).toBeLessThan(500_000_00);
    expect(s.ownership.titles[target.id]).toBe('bank');
  });
  it('pays rent once per round to the owner, never for visiting', () => {
    let s = patch(newMatch(), (d) => { d.ownership.titles.offices = 'p1'; });
    s = toRound(s, 2);
    expect(s.players.p1.positions.offices.income).toBe(s.properties.offices.lastNOI);
    expect(s.players.p2.positions.offices).toBeUndefined();
  });
  it('grants the warehouse synergy once to a controller who also owns the title', () => {
    let s = giveUnits(newMatch(), 'p1', 'harb', 5001);
    const base = s.companies.harb.lastMargin;
    s = patch(s, (d) => { d.ownership.titles.warehouse = 'p1'; d.macro.commodity = 100; });
    s = toRound(s, 2);
    const commodityDrag = s.content.sectors.logistics.commoditySens * 0;
    expect(s.companies.harb.lastMargin).toBeGreaterThanOrEqual(base + 100 + commodityDrag - 60);
  });
});

describe('macro, events and information', () => {
  it('never opens round 1 in Crisis and keeps disasters out of the first two rounds', () => {
    for (let i = 0; i < 150; i++) {
      let s = newMatch(2, 12, `seed-${i}`);
      expect(s.macro.regime).not.toBe('crisis');
      const early = () => s.log.filter((e) => e.type === 'news_event').map((e) => e.data?.eventId);
      s = toRound(s, 2);
      expect(early()).not.toContain('rate_shock');
      expect(early()).not.toContain('credit_freeze');
    }
  });
  it('keeps macro values inside their bounds across long runs', () => {
    for (let i = 0; i < 20; i++) {
      let s = newMatch(2, 20, `bounds-${i}`);
      while (s.phase !== 'finished') {
        s = passOnce(s);
        const m = s.macro;
        expect(m.gdp >= -800 && m.gdp <= 600 && m.rate >= 100 && m.rate <= 1200 && m.inflation >= 0 && m.inflation <= 1000).toBe(true);
        expect(m.sentiment >= 5500 && m.sentiment <= 14_500 && m.commodity >= 60 && m.commodity <= 180).toBe(true);
        for (const c of s.content.companies) {
          const v = valueCompany(s, c.id);
          expect(v.multipleBps >= 30_000 && v.multipleBps <= 140_000 && v.mark >= 50 && v.mark <= 1_000_00).toBe(true);
        }
      }
    }
  });
  it('expires event modifiers after their duration', () => {
    const s = newMatch(2, 12, 'test', 'tutorial');
    expect(s.modifiers.some((m) => m.eventId === 'cloud_wave' && m.metric === 'growth' && m.roundsLeft === 2)).toBe(true);
    expect(toRound(s, 2).modifiers.some((m) => m.eventId === 'cloud_wave' && m.roundsLeft === 1)).toBe(true);
    expect(toRound(s, 3).modifiers.some((m) => m.eventId === 'cloud_wave')).toBe(false);
  });
  it('plays the labelled tutorial script, then returns to normal draws', () => {
    let s = newMatch(2, 12, 'test', 'tutorial');
    const regimes = [s.macro.regime];
    for (let r = 2; r <= 5; r++) { s = toRound(s, r); regimes.push(s.macro.regime); }
    expect(regimes).toEqual(['expansion', 'expansion', 'expansion', 'boom', 'stagflation']);
    expect(s.log.some((e) => e.data?.eventId === 'rate_shock')).toBe(true);
  });
  it('research returns a bounded private signal and never rerolls', () => {
    let s = goTo(newMatch(), 'p1', ['wallstreet']);
    const draws = s.rng.macro.draws;
    s = act(s, 'p1', { type: 'Research', sector: 'tech' });
    const sig = s.players.p1.research[0];
    expect(Math.abs(sig.midpoint - s.hidden.sectorDemand.tech)).toBeLessThanOrEqual(200);
    expect(sig.high - sig.low).toBe(600);
    s = act(s, 'p1', { type: 'Research', sector: 'tech' });
    expect(s.players.p1.research).toHaveLength(1);
    expect(s.players.p1.research[0].midpoint).toBe(sig.midpoint);
    expect(s.players.p1.research[0].confidence).toBe(75);
    expect(s.rng.macro.draws).toBe(draws); // research never perturbs the macro stream
  });
  it('projects observations without RNG, pending news, journal, rival research or third-party offers', () => {
    let s = goTo(newMatch(3), 'p1', ['wallstreet']);
    s = act(s, 'p1', { type: 'Research', sector: 'tech' });
    s = act(s, 'p1', { type: 'ProposeTrade', recipient: 'p2', give: { cash: 5_00, units: {}, properties: [] }, receive: { cash: 0, units: {}, properties: [] }, note: 'secret' });
    const o3 = getObservation(s, 'p3');
    const text = JSON.stringify({ ...o3.state, content: null });
    expect(o3.state.rng).toEqual({});
    expect(o3.state.hidden.pendingRegime).toBe(null);
    expect(Object.values(o3.state.hidden.sectorDemand).every((x) => x === 0)).toBe(true);
    expect(o3.state.players.p1.research).toEqual([]);
    expect(Object.keys(o3.state.offers)).toHaveLength(0);
    expect(o3.state.journal).toEqual([]);
    expect(text).not.toContain('secret');
    expect(getObservation(s, 'p1').state.players.p1.research).toHaveLength(1);
    expect(Object.keys(getObservation(s, 'p2').state.offers)).toHaveLength(1);
  });
});

describe('endgame', () => {
  it('finishes after the final Close with no extra news draw and ranks by adjusted net worth', () => {
    let s = newMatch(2, 12, 'end');
    s = act(goTo(s, 'p1', ['wallstreet']), 'p1', { type: 'MarketOrder', companyId: 'mpwr', shares: 1000 });
    const drawsBefore = () => s.rng.macro.draws;
    s = toRound(s, 12);
    const d = drawsBefore();
    s = passUntil(s, (x) => x.phase === 'finished');
    expect(s.rng.macro.draws).toBe(d);
    expect(s.round).toBe(12);
    const res = s.result;
    expect(res?.rows[0].adjusted).toBe(valuePortfolio(s, res?.rows[0].seat ?? '').adjusted);
    expect(res?.rows[0].adjusted).toBeGreaterThanOrEqual(res?.rows[1].adjusted ?? 0);
    expect(res?.rows.every((r) => r.bonus === s.players[r.seat].reputation * 100_00 && r.bonus <= 10_000_00)).toBe(true);
    expect(tryAct(s, 'p1', { type: 'EndTurn' }).error?.code).toBe('finished');
    expect(reservedCash(s, 'p1')).toBe(0);
  });
  it('shares the win on an exact tie', () => {
    const s = passUntil(newMatch(2, 12, 'tie'), (x) => x.phase === 'finished');
    expect(s.result?.winners).toEqual(['p1', 'p2']);
  });
});
