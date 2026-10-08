// Heuristic AI. It sees only a seat-filtered observation and returns one command at a time.
// No RNG and no hidden state: choices are a deterministic function of the observation.
import {
  type Archetype, type Command, type DistrictId, type MatchState, type Money, type Pledge, type SeatId, type SeatObservation,
  DISTRICTS, auctionAssetValue, availableUnits, bankAskBusiness, bankAskProperty, currentPrompt, debtService, distressPropertyPrice,
  distressUnitPrice, expectedDividend, forecastGrowth, liquidityWarning, loansByPriority, minBid, minTenderPrice, mulBps,
  mulDivFloor, propertyNOI, propertyPledged, propertyValue, quoteCorpRefinance, quoteLoan, reinvestBoost, researchDistricts,
  spendable, totalArrears, unitValue, unitsOf, valueCompany, valuePortfolio,
} from '@capital/engine';

interface Profile {
  levMin: number; levMax: number; serviceMult: number; baseReserve: Money; concentration: number; payout: number;
  /** Extra expected-return weight (bps) by taste. */
  dividendWeight: number; growthWeight: number; valueWeight: number; controlBonus: number;
  acceptMargin: number; auctionCeiling: number; tenderAccept: number; minReturn: number;
}

const PROFILES: Record<Archetype, Profile> = {
  grace: { levMin: 0, levMax: 2000, serviceMult: 2, baseReserve: 75_000_00, concentration: 4000, payout: 7500, dividendWeight: 150, growthWeight: 60, valueWeight: 150, controlBonus: 0, acceptMargin: 300, auctionCeiling: 9000, tenderAccept: 11_500, minReturn: 900 },
  alex: { levMin: 2000, levMax: 4500, serviceMult: 1.5, baseReserve: 40_000_00, concentration: 6000, payout: 2500, dividendWeight: 60, growthWeight: 160, valueWeight: 50, controlBonus: 200, acceptMargin: 0, auctionCeiling: 10_000, tenderAccept: 13_000, minReturn: 700 },
  victor: { levMin: 4000, levMax: 6000, serviceMult: 1, baseReserve: 25_000_00, concentration: 8000, payout: 7500, dividendWeight: 100, growthWeight: 100, valueWeight: 100, controlBonus: 900, acceptMargin: 500, auctionCeiling: 9500, tenderAccept: 12_000, minReturn: 600 },
};

export const AI_NAMES: Record<Archetype, string> = { grace: 'Grace', alex: 'Alex', victor: 'Victor' };
export const AI_BLURBS: Record<Archetype, string> = {
  grace: 'Value investor. Likes dividends, hates debt, reads footnotes for fun.',
  alex: 'Growth chaser. Pays up for tech and reinvests everything.',
  victor: 'Raider. Borrows hard, hunts control and circles distressed sellers.',
};

function distances(s: MatchState, from: DistrictId): Record<DistrictId, number> {
  const dist = {} as Record<DistrictId, number>;
  for (const d of DISTRICTS) dist[d] = 99;
  dist[from] = 0;
  const queue: DistrictId[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift() as DistrictId;
    for (const [a, b] of s.content.edges) {
      const next = a === cur ? b : b === cur ? a : null;
      if (next && dist[next] > dist[cur] + 1) {
        dist[next] = dist[cur] + 1;
        queue.push(next);
      }
    }
  }
  return dist;
}

function stepToward(s: MatchState, from: DistrictId, to: DistrictId): DistrictId {
  const d = distances(s, to);
  let best = from;
  for (const [a, b] of s.content.edges) {
    const next = a === from ? b : b === from ? a : null;
    if (next && d[next] < d[best]) best = next;
  }
  return best;
}

function reserveFor(s: MatchState, seat: SeatId, p: Profile): Money {
  return Math.round(debtService(s, seat) * p.serviceMult) + p.baseReserve;
}

/** Expected two-round return on money put into a company at `price` per whole-company equity, in bps. */
function companyReturnBps(s: MatchState, seat: SeatId, companyId: string, pricePerEquityBps: number, p: Profile): number {
  const v = valueCompany(s, companyId);
  const co = s.companies[companyId];
  const def = s.content.companies.find((c) => c.id === companyId);
  if (!def) return -99_999;
  const signal = s.players[seat].research.find((r) => r.sector === def.sector && r.round === s.round);
  const growth = forecastGrowth(s, companyId).total + (signal ? signal.midpoint : 0);
  const divYield = mulDivFloor(expectedDividend(s, companyId), 10_000, Math.max(v.equity, 1));
  const earnYield = mulDivFloor(Math.max(co.lastNet, 0), 10_000, Math.max(v.equity, 1));
  const retained = Math.max(0, earnYield - divYield);
  // two years of income and growth, less what we overpay relative to fair value today
  const base = 2 * (divYield * p.dividendWeight + (growth + retained) * p.growthWeight) / 100;
  const premium = pricePerEquityBps - 10_000;
  return Math.round(base - (premium * p.valueWeight) / 100 - def.risk * 40);
}

interface Option { score: number; district: DistrictId | null; command: Command; why: string }

function allCollateral(s: MatchState, seat: SeatId): Pledge[] {
  const out: Pledge[] = [];
  for (const def of s.content.companies) {
    const n = availableUnits(s, seat, def.id);
    if (n > 0) out.push({ kind: 'units', companyId: def.id, units: n });
  }
  for (const def of s.content.properties) if (s.ownership.titles[def.id] === seat && !propertyPledged(s, def.id)) out.push({ kind: 'property', propertyId: def.id });
  return out;
}

function turnOptions(s: MatchState, seat: SeatId, p: Profile, arche: Archetype): Option[] {
  const me = s.players[seat];
  const v = valuePortfolio(s, seat);
  const reserve = reserveFor(s, seat, p);
  const free = Math.max(0, spendable(s, seat) - reserve);
  const opts: Option[] = [];
  const nw = Math.max(v.netWorth, 1);
  const cap = (held: Money) => Math.max(0, mulBps(Math.max(v.assets, 1), p.concentration) - held);

  // --- debt discipline first
  const myLoans = loansByPriority(s, seat);
  const overLevered = v.leverageBps > p.levMax + 500;
  if ((overLevered || liquidityWarning(s, seat)) && myLoans.length > 0) {
    const l = [...myLoans].sort((a, b) => b.rate - a.rate)[0];
    const amt = Math.min(l.principal + l.arrears, Math.max(0, spendable(s, seat) - p.baseReserve));
    if (amt > 1_000_00) opts.push({ score: 50_000, district: null, command: { type: 'Repay', loanId: l.id, amount: amt }, why: 'pays down debt' });
  }
  if (liquidityWarning(s, seat)) {
    for (const def of s.content.companies) {
      if (def.kind !== 'public') continue;
      const n = availableUnits(s, seat, def.id);
      if (n > 0) opts.push({ score: 40_000, district: 'wallstreet', command: { type: 'MarketOrder', companyId: def.id, shares: -Math.min(n, 1500) }, why: 'raises cash' });
    }
  }

  // --- public shares
  for (const def of s.content.companies) {
    const val = valueCompany(s, def.id);
    const held = unitsOf(s, seat, def.id);
    if (def.kind === 'public') {
      const float = unitsOf(s, 'bank', def.id);
      const budget = Math.min(free, cap(val.mark * held));
      const want = Math.min(float, 1500, Math.floor(budget / Math.max(1, mulBps(val.mark, 10_400))));
      const pricePerEquity = mulDivFloor(val.mark, 10_000, Math.max(val.fairPerShare, 1)) + 150;
      let r = companyReturnBps(s, seat, def.id, pricePerEquity, p);
      const stakeAfter = held + want;
      if (p.controlBonus > 0 && stakeAfter * 4 >= def.sharesOutstanding) r += p.controlBonus;
      if (want >= 10 && r > p.minReturn) {
        const score = mulBps(val.mark * want, r);
        opts.push({ score, district: 'wallstreet', command: { type: 'MarketOrder', companyId: def.id, shares: want }, why: `buys ${def.ticker}` });
      }
      // take profits on rich prices
      const rich = arche === 'grace' ? 13_000 : 16_000;
      const free2 = availableUnits(s, seat, def.id);
      if (free2 > 0 && val.sentimentBps > rich && s.control[def.id] !== seat) {
        opts.push({ score: mulBps(val.mark * free2, val.sentimentBps - 10_000) / 2, district: 'wallstreet', command: { type: 'MarketOrder', companyId: def.id, shares: -Math.min(free2, 1500) }, why: `trims ${def.ticker}` });
      }
      // tender for control
      if (arche === 'victor' && !s.tender && held * 5 >= def.sharesOutstanding && held * 2 <= def.sharesOutstanding) {
        const need = Math.floor(def.sharesOutstanding / 2) + 1 - held;
        const price = minTenderPrice(s, def.id);
        if (price * need <= spendable(s, seat) - p.baseReserve) opts.push({ score: mulBps(price * need, 1500), district: 'wallstreet', command: { type: 'Tender', companyId: def.id, price, maxShares: need, minShares: need }, why: `tenders for ${def.ticker}` });
      }
    } else if (unitsOf(s, 'bank', def.id) === def.sharesOutstanding && !(s.auction?.asset.kind === 'units' && s.auction.asset.companyId === def.id)) {
      const price = bankAskBusiness(s, def.id);
      const r = companyReturnBps(s, seat, def.id, 10_500, p) + p.controlBonus / 2;
      if (price <= free && price <= cap(0) && r > p.minReturn) {
        const score = mulBps(price, r);
        opts.push({ score, district: def.district, command: { type: 'BuyAsset', asset: { kind: 'business', companyId: def.id } }, why: `buys ${def.name}` });
      }
    }
    // --- control actions
    if (s.control[def.id] === seat && s.companies[def.id].policyRound !== s.round) {
      const co = s.companies[def.id];
      if (arche === 'alex' && co.cash > 5_000_00 && co.arrears === 0 && co.pendingBoost === 0) {
        const amount = Math.min(co.cash, mulBps(co.revenue, 800));
        const gain = mulBps(val.equity, reinvestBoost(co.revenue, amount)) - amount / 2;
        if (gain > 0) opts.push({ score: gain, district: def.district, command: { type: 'Reinvest', companyId: def.id, amount }, why: `reinvests in ${def.name}` });
      } else if (co.payout !== p.payout) {
        opts.push({ score: mulBps(Math.max(co.lastNet, 0), Math.abs(p.payout - co.payout)) / 2, district: def.district, command: { type: 'SetPolicy', companyId: def.id, payout: p.payout }, why: `sets ${def.name} payout` });
      } else if (co.debtRate > 0 && quoteCorpRefinance(s, def.id).approved && quoteCorpRefinance(s, def.id).rate + 100 < co.debtRate) {
        opts.push({ score: mulBps(co.debt, co.debtRate - quoteCorpRefinance(s, def.id).rate) * 3, district: def.district, command: { type: 'CorpRefinance', companyId: def.id }, why: `refinances ${def.name}` });
      }
    }
  }

  // --- property
  const propWeight = arche === 'grace' ? 130 : arche === 'victor' ? 100 : 70;
  for (const def of s.content.properties) {
    if (s.ownership.titles[def.id] !== 'bank' || (s.auction?.asset.kind === 'property' && s.auction.asset.propertyId === def.id)) continue;
    const price = bankAskProperty(s, def.id);
    const yieldBps = mulDivFloor(Math.max(propertyNOI(s, def.id), 0), 10_000, price);
    const r = Math.round((2 * (yieldBps + s.macro.inflation / 2) * propWeight) / 100 - 500);
    if (price <= free && price <= cap(0) && r > p.minReturn) {
      const score = mulBps(price, r);
      opts.push({ score, district: def.district, command: { type: 'BuyAsset', asset: { kind: 'property', propertyId: def.id } }, why: `buys ${def.name}` });
    }
  }

  // --- leverage toward the archetype's band, only if there is something worth buying
  if (v.leverageBps < p.levMin + 500 && s.round >= me.freezeUntil && s.round < s.totalRounds - 1) {
    const targetBps = Math.round((p.levMin + p.levMax) / 2);
    const desired = Math.max(0, mulDivFloor(nw, targetBps, 10_000 - targetBps) - v.loanPrincipal);
    const collateral = allCollateral(s, seat);
    for (const frac of [100, 70, 45, 25]) {
      const principal = Math.floor((desired * frac) / 100 / 1_000_00) * 1_000_00;
      if (principal < 20_000_00) break;
      const q = quoteLoan(s, seat, principal, 5, 'fixed', collateral);
      if (!q.approved) continue;
      // worth it when assets return more than the loan costs over two years
      const edge = 2 * (1200 - q.rate);
      if (edge > 0) opts.push({ score: mulBps(principal, edge), district: 'financial', command: { type: 'Borrow', principal, term: 5, rateType: 'fixed', collateral }, why: 'borrows to invest' });
      break;
    }
  }

  // --- small conveniences
  if (me.district === 'financial' && me.relationshipRound !== s.round && me.reputation < 100) opts.push({ score: 300_00, district: 'financial', command: { type: 'BuildRelationship' }, why: 'works the room' });
  if (arche !== 'victor') {
    const sector = arche === 'alex' ? 'tech' : 'utilities';
    if (!me.research.some((r) => r.sector === sector && r.round === s.round) && researchDistricts(s.content, sector).includes(me.district)) {
      opts.push({ score: 200_00, district: me.district, command: { type: 'Research', sector }, why: `researches ${sector}` });
    }
  }

  // --- Victor circles distressed sellers with a binding lowball
  if (arche === 'victor' && me.proposalsThisRound === 0 && !Object.values(s.offers).some((o) => o.status === 'open' && o.proposer === seat)) {
    for (const other of s.seatOrder) {
      if (other === seat || !liquidityWarning(s, other)) continue;
      for (const def of s.content.companies) {
        const n = availableUnits(s, other, def.id);
        if (n <= 0) continue;
        const value = unitValue(s, def.id, n);
        const cash = mulBps(value, 7000);
        if (cash > 10_000_00 && cash <= free) {
          opts.push({ score: value - cash, district: null, command: { type: 'ProposeTrade', recipient: other, give: { cash, units: {}, properties: [] }, receive: { cash: 0, units: { [def.id]: n }, properties: [] }, note: 'Cash today. Nobody else is offering.' }, why: 'makes a distressed offer' });
          break;
        }
      }
    }
  }
  return opts;
}

function chooseTurn(s: MatchState, seat: SeatId, arche: Archetype): { command: Command; why: string } {
  const p = PROFILES[arche];
  const me = s.players[seat];
  if (s.apRemaining <= 0) return { command: { type: 'EndTurn' }, why: 'ends turn' };
  const dist = distances(s, me.district);
  let best: (Option & { eff: number }) | null = null;
  for (const o of turnOptions(s, seat, p, arche)) {
    if (o.score <= 0) continue;
    const d = o.district === null ? 0 : dist[o.district];
    // an action reachable this year keeps most of its value; one that needs next year is heavily discounted
    const eff = d < s.apRemaining ? (o.score * (10 - d)) / 10 : o.score * 0.25;
    if (!best || eff > best.eff) best = { ...o, eff };
  }
  if (!best) return { command: { type: 'EndTurn' }, why: 'ends turn' };
  if (best.district === null || best.district === me.district) return { command: best.command, why: best.why };
  return { command: { type: 'Move', to: stepToward(s, me.district, best.district) }, why: `heads out: ${best.why}` };
}

function bundleValue(s: MatchState, b: { cash: Money; units: Record<string, number>; properties: string[] }): Money {
  let n = b.cash;
  for (const [id, u] of Object.entries(b.units)) n += unitValue(s, id, u);
  for (const id of b.properties) n += propertyValue(s, id);
  return n;
}

function respondOffer(s: MatchState, seat: SeatId, offerId: string, p: Profile): Command {
  const o = s.offers[offerId];
  const yes: Command = { type: 'AcceptOffer', offerId };
  const no: Command = { type: 'RejectOffer', offerId };
  if (!o) return no;
  const reserve = reserveFor(s, seat, p);
  if (o.terms.kind === 'trade') {
    const gets = bundleValue(s, o.give);
    const gives = bundleValue(s, o.receive);
    if (o.receive.cash > 0 && spendable(s, seat) - o.receive.cash < reserve / 2) return no;
    return gets >= gives + mulBps(gives, p.acceptMargin) && gets > 0 ? yes : no;
  }
  if (o.terms.kind === 'loan') {
    const t = o.terms;
    if (t.lender === seat) {
      const borrower = valuePortfolio(s, t.borrower);
      const safe = borrower.netWorth > t.principal * 2 && borrower.leverageBps < 5500;
      return t.rate >= Math.max(700, s.macro.rate + 300) && safe && spendable(s, seat) - t.principal >= reserve ? yes : no;
    }
    return t.rate <= 900 && (liquidityWarning(s, seat) || totalArrears(s, seat) > 0) ? yes : no;
  }
  const t = o.terms;
  const def = s.content.companies.find((c) => c.id === t.companyId);
  if (!def) return no;
  const perRound = mulDivFloor(mulDivFloor(expectedDividend(s, t.companyId), unitsOf(s, t.seller, t.companyId), def.sharesOutstanding), t.bps, 10_000);
  const worth = perRound * t.rounds;
  if (t.buyer === seat) return mulBps(worth, 8000) >= t.price && spendable(s, seat) - t.price >= reserve ? yes : no;
  return t.price >= mulBps(worth, 11_000) ? yes : no;
}

function rescue(s: MatchState, seat: SeatId): Command {
  const due = totalArrears(s, seat);
  for (const def of s.content.companies) {
    const n = availableUnits(s, seat, def.id);
    if (n <= 0) continue;
    if (def.kind === 'public') {
      const all = distressUnitPrice(s, def.id, n);
      const shares = all <= due ? n : Math.min(n, Math.ceil((due * n) / Math.max(all, 1)) + 1);
      return { type: 'MarketOrder', companyId: def.id, shares: -shares };
    }
  }
  for (const def of s.content.companies) {
    const n = availableUnits(s, seat, def.id);
    if (n > 0 && def.kind === 'private') return { type: 'SellAsset', asset: { kind: 'business', companyId: def.id, units: n } };
  }
  for (const def of s.content.properties) {
    if (s.ownership.titles[def.id] === seat && !propertyPledged(s, def.id) && distressPropertyPrice(s, def.id) > 0) return { type: 'SellAsset', asset: { kind: 'property', propertyId: def.id } };
  }
  return { type: 'Restructure' };
}

export interface AiChoice { command: Command; why: string }

/** Pick the next command for the observing AI seat. Returns null if it is not that seat's move. */
export function chooseAction(obs: SeatObservation, archetypeOverride?: Archetype): AiChoice | null {
  const s = obs.state;
  const seat = obs.seat;
  if (!seat) return null;
  const prompt = currentPrompt(s);
  if (prompt.kind === 'none' || prompt.seat !== seat) return null;
  const arche = archetypeOverride ?? s.players[seat].archetype ?? 'grace';
  const p = PROFILES[arche];
  switch (prompt.kind) {
    case 'turn': return chooseTurn(s, seat, arche);
    case 'offer': {
      const command = respondOffer(s, seat, prompt.offerId, p);
      return { command, why: command.type === 'AcceptOffer' ? 'accepts the deal' : 'declines the deal' };
    }
    case 'tender': {
      const t = s.tender;
      if (!t) return { command: { type: 'TenderResponse', shares: 0 }, why: 'declines' };
      const fair = valueCompany(s, t.companyId).fairPerShare;
      const sell = s.control[t.companyId] !== seat && t.price >= mulBps(fair, p.tenderAccept);
      const shares = sell ? availableUnits(s, seat, t.companyId) : 0;
      return { command: { type: 'TenderResponse', shares }, why: shares > 0 ? 'tenders shares' : 'holds out' };
    }
    case 'auction': {
      const a = s.auction;
      const need = minBid(s);
      if (!a) return { command: { type: 'PassAuction' }, why: 'passes' };
      const ceiling = Math.min(mulBps(auctionAssetValue(s, a.asset), p.auctionCeiling), spendable(s, seat) - reserveFor(s, seat, p));
      return need <= ceiling ? { command: { type: 'Bid', amount: need }, why: 'bids' } : { command: { type: 'PassAuction' }, why: 'passes' };
    }
    case 'rescue': return { command: rescue(s, seat), why: 'scrambles for cash' };
  }
}

export { PROFILES };
