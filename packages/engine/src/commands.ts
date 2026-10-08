// Engine API: match creation, command validation/application, observations, replay and audit.
import {
  AP_PER_TURN, type Ctx, RULES_VERSION, SCHEMA_VERSION, addRep, count, emit, newId, reservedCash, spendable, trackMinCash,
} from './core';
import {
  acceptOffer, bid, launchTender, listAuction, passAuction, proposeLoan, proposeRights, proposeTrade, rejectOffer, tenderResponse, withdrawOffer,
} from './deals';
import { borrow, refinance, repay, totalArrears } from './loans';
import { drawNews } from './macro';
import {
  buyBusiness, buyProperty, corpRefinance, corpRepay, marketOrder, reinvest, sellBusiness, sellProperty, setPolicy, upgradeProperty,
} from './market';
import { RuleError, mulBps, reject } from './money';
import { advance, afterRescueDecision, afterRescueResponse, currentPrompt, endTurn, openRound } from './phases';
import { canonical, makeStream, randInt, sha256Hex } from './rng';
import {
  DISTRICTS, SECTORS, type ApplyResult, type Command, type CommandEnvelope, type CommandType, type ContentPack, type DistrictId, type GameEvent,
  type MatchConfig, type MatchState, type Player, type Sector, type SeatId,
} from './types';

export const STARTING_CASH = 500_000_00;
const zeroDemand = (): Record<Sector, number> => ({ tech: 0, utilities: 0, consumer: 0, industrial: 0, logistics: 0, health: 0 });

export function createMatch(config: MatchConfig, seed: string, content: ContentPack): MatchState {
  if (config.seats.length < 2 || config.seats.length > 4) throw new Error('A match needs 2–4 seats.');
  if (new Set(config.seats.map((x) => x.id)).size !== config.seats.length) throw new Error('Seat ids must be unique.');
  if (config.seats.some((x) => x.id === 'bank' || x.id === 'system' || !/^[a-z0-9_-]{1,24}$/i.test(x.id))) throw new Error('Invalid seat id.');
  if (config.totalRounds !== 12 && config.totalRounds !== 20) throw new Error('Matches run 12 or 20 rounds.');
  const players: Record<SeatId, Player> = {};
  for (const seat of config.seats) {
    players[seat.id] = {
      id: seat.id, name: seat.name.slice(0, 24) || seat.id, color: seat.color, kind: seat.kind, archetype: seat.archetype,
      cash: STARTING_CASH, reputation: 60, district: 'financial', research: [], grants: 0, minCash: STARTING_CASH, freezeUntil: 0,
      proposalsThisRound: 0, relationshipRound: 0, repFromContracts: 0, repContractRound: 0, repCompanyRound: 0, propertyArrears: 0,
      incomeThisRound: 0, lastIncome: 0, history: [], positions: {}, actionCounts: {},
    };
  }
  const rng: MatchState['rng'] = { macro: makeStream(seed, 'macro'), event: makeStream(seed, 'event'), research: makeStream(seed, 'research'), ai: makeStream(seed, 'ai') };
  const s: MatchState = {
    schemaVersion: SCHEMA_VERSION, rulesVersion: RULES_VERSION, contentVersion: content.version, matchId: config.matchId, scenario: config.scenario,
    revision: 0, round: 1, totalRounds: config.totalRounds, phase: 'open',
    seatOrder: config.seats.map((x) => x.id), startIndex: 0, turnIndex: 0, activeSeat: config.seats[0].id, apRemaining: AP_PER_TURN,
    players,
    macro: {
      regime: 'recovery', gdp: 210, inflation: 240, rate: 400, confidence: 55, credit: 40, commodity: 100, sentiment: 10_000,
      sectorSentiment: { tech: 10_000, utilities: 10_000, consumer: 10_000, industrial: 10_000, logistics: 10_000, health: 10_000 },
      crisisStreak: 0, explanations: [],
    },
    modifiers: [], companies: {}, properties: {}, ownership: { units: {}, titles: {} }, control: {},
    loans: {}, offers: {}, contracts: [], auction: null, listings: [], auctionCursor: 0, tender: null, flow: {}, distress: null,
    warnings: {}, eventLastRound: {}, headline: '', nextId: 1, bankCash: 0, economyCash: 0, log: [], journal: [],
    rng, hidden: { pendingRegime: null, pendingEvents: [], pendingShift: null, sectorDemand: zeroDemand() }, result: null, content,
  };
  for (const def of content.companies) {
    rng[`company:${def.id}`] = makeStream(seed, `company:${def.id}`);
    const ebit = mulBps(def.revenue, def.baseMargin);
    const rate = def.initialDebt > 0 ? 600 : 0;
    const net = ebit - mulBps(def.initialDebt, rate);
    const payout = def.kind === 'private' ? 5000 : def.payout;
    s.companies[def.id] = {
      id: def.id, revenue: def.revenue, lastEBIT: ebit, lastNet: net, lastGrowth: def.baseGrowth, lastMargin: def.baseMargin,
      lastDividend: net > 0 ? mulBps(net, payout) : 0, cash: def.initialCash, debt: def.initialDebt, debtRate: rate, debtMaturity: null,
      arrears: 0, payout, sentiment: 10_000, boost: 0, pendingBoost: 0, policyRound: 0,
    };
    s.ownership.units[def.id] = { bank: def.sharesOutstanding };
    s.control[def.id] = null;
  }
  for (const def of content.properties) {
    s.properties[def.id] = { id: def.id, grossRent: def.grossRent, expense: def.expense, occupancy: def.occupancy, upgrades: 0, lastNOI: mulBps(def.grossRent, def.occupancy) - def.expense };
    s.ownership.titles[def.id] = 'bank';
  }
  const ctx: Ctx = { s, events: [], dry: false };
  drawNews(ctx, 1);
  openRound(ctx);
  return s;
}

function cloneState(state: MatchState): MatchState {
  const { journal, log, content, ...rest } = state;
  return { ...structuredClone(rest), journal: journal.slice(), log: log.slice(), content };
}

const AP_COST: Partial<Record<CommandType, number>> = {
  Move: 1, MarketOrder: 1, Research: 1, Borrow: 1, Refinance: 1, Repay: 1, BuyAsset: 1, SellAsset: 1, SetPolicy: 1, Reinvest: 1, CorpRepay: 1,
  CorpRefinance: 1, Upgrade: 1, ProposeTrade: 1, ProposeLoan: 1, ProposeRights: 1, ListAuction: 1, Tender: 1, BuildRelationship: 1,
  WithdrawOffer: 0, EndTurn: 0,
};

export function apCost(type: CommandType): number {
  return AP_COST[type] ?? 0;
}

export function adjacent(content: ContentPack, a: DistrictId, b: DistrictId): boolean {
  return content.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export function researchDistricts(content: ContentPack, sector: Sector): DistrictId[] {
  return ['wallstreet', ...new Set(content.companies.filter((c) => c.sector === sector).map((c) => c.district))];
}

function at(s: MatchState, seat: SeatId, district: DistrictId, what: string): void {
  if (s.players[seat].district !== district) reject('wrong_district', `${what} happens in ${DISTRICT_NAMES[district]}.`);
}

export const DISTRICT_NAMES: Record<DistrictId, string> = {
  financial: 'Financial', wallstreet: 'Wall Street', industrial: 'Industrial', tech: 'Tech', energy: 'Energy', realestate: 'Real Estate', downtown: 'Downtown',
};

function companyDistrict(s: MatchState, companyId: string): DistrictId {
  const d = s.content.companies.find((c) => c.id === companyId);
  if (!d) reject('unknown_company', 'Unknown company.');
  return d.district;
}

function propertyDistrict(s: MatchState, propertyId: string): DistrictId {
  const d = s.content.properties.find((c) => c.id === propertyId);
  if (!d) reject('unknown_property', 'Unknown property.');
  return d.district;
}

function research(ctx: Ctx, seat: SeatId, sector: Sector): void {
  const s = ctx.s;
  if (!(SECTORS as readonly string[]).includes(sector)) reject('bad_sector', 'Unknown sector.');
  const p = s.players[seat];
  if (!researchDistricts(s.content, sector).includes(p.district)) reject('wrong_district', 'Research this sector on Wall Street or in the sector\'s home district.');
  const prior = p.research.find((r) => r.sector === sector && r.round === s.round);
  if (prior) {
    if (prior.confidence >= 75) reject('already_researched', 'You have already double-checked this sector this year.');
    prior.confidence = 75; // repeat research confirms the same signal; it never rerolls
  } else {
    const noise = ctx.dry ? 0 : randInt(s.rng.research, -200, 200);
    const midpoint = s.hidden.sectorDemand[sector] + noise;
    p.research.push({ id: newId(ctx, 'S'), sector, round: s.round, expiresRound: s.round + 1, midpoint, low: midpoint - 300, high: midpoint + 300, confidence: 65 });
  }
  count(s, seat, 'research');
  emit(ctx, 'research_done', `${p.name} commissioned research.`, { seat });
}

function turnCommand(ctx: Ctx, seat: SeatId, cmd: Command): void {
  const s = ctx.s;
  const p = s.players[seat];
  const cost = AP_COST[cmd.type];
  if (cost === undefined) reject('not_now', 'That action is not available during your turn.');
  if (s.apRemaining < cost) reject('no_ap', 'You have no action points left this year.');
  switch (cmd.type) {
    case 'Move':
      if (!(DISTRICTS as readonly string[]).includes(cmd.to) || !adjacent(s.content, p.district, cmd.to)) reject('not_adjacent', 'You can only move to a connected district.');
      p.district = cmd.to;
      emit(ctx, 'moved', `${p.name} moved to ${DISTRICT_NAMES[cmd.to]}.`, { seat, data: { to: cmd.to } });
      break;
    case 'MarketOrder': at(s, seat, 'wallstreet', 'Share trading'); marketOrder(ctx, seat, cmd.companyId, cmd.shares, false); break;
    case 'Research': research(ctx, seat, cmd.sector); break;
    case 'Borrow': at(s, seat, 'financial', 'Borrowing'); borrow(ctx, seat, cmd.principal, cmd.term, cmd.rateType, cmd.collateral); break;
    case 'Refinance': at(s, seat, 'financial', 'Refinancing'); refinance(ctx, seat, cmd.loanId, cmd.term, cmd.rateType); break;
    case 'Repay': repay(ctx, seat, cmd.loanId, cmd.amount); break;
    case 'BuyAsset':
      if (cmd.asset.kind === 'business') { at(s, seat, companyDistrict(s, cmd.asset.companyId), 'Buying this business'); buyBusiness(ctx, seat, cmd.asset.companyId); }
      else { at(s, seat, propertyDistrict(s, cmd.asset.propertyId), 'Buying this property'); buyProperty(ctx, seat, cmd.asset.propertyId); }
      break;
    case 'SellAsset':
      if (cmd.asset.kind === 'business') { at(s, seat, companyDistrict(s, cmd.asset.companyId), 'Selling this business'); sellBusiness(ctx, seat, cmd.asset.companyId, cmd.asset.units, false); }
      else { at(s, seat, propertyDistrict(s, cmd.asset.propertyId), 'Selling this property'); sellProperty(ctx, seat, cmd.asset.propertyId, false); }
      break;
    case 'SetPolicy': at(s, seat, companyDistrict(s, cmd.companyId), 'Setting policy'); setPolicy(ctx, seat, cmd.companyId, cmd.payout); break;
    case 'Reinvest': at(s, seat, companyDistrict(s, cmd.companyId), 'Reinvesting'); reinvest(ctx, seat, cmd.companyId, cmd.amount); break;
    case 'CorpRepay': at(s, seat, companyDistrict(s, cmd.companyId), 'Corporate repayment'); corpRepay(ctx, seat, cmd.companyId, cmd.amount); break;
    case 'CorpRefinance': at(s, seat, companyDistrict(s, cmd.companyId), 'Corporate refinancing'); corpRefinance(ctx, seat, cmd.companyId); break;
    case 'Upgrade': at(s, seat, propertyDistrict(s, cmd.propertyId), 'Upgrading'); upgradeProperty(ctx, seat, cmd.propertyId); break;
    case 'BuildRelationship':
      at(s, seat, 'financial', 'Relationship building');
      if (p.relationshipRound === s.round) reject('once_per_round', 'You have already worked the room this year.');
      if (p.reputation >= 100) reject('maxed', 'Your reputation cannot get any better.');
      p.relationshipRound = s.round;
      addRep(ctx, seat, 3);
      emit(ctx, 'relationship', `${p.name} took the bankers to lunch. Reputation +3.`, { seat });
      break;
    case 'ProposeTrade': proposeTrade(ctx, seat, cmd.recipient, cmd.give, cmd.receive, cmd.note); break;
    case 'ProposeLoan': proposeLoan(ctx, seat, cmd.recipient, cmd.role, cmd.principal, cmd.rate, cmd.term, cmd.collateral); break;
    case 'ProposeRights': proposeRights(ctx, seat, cmd.recipient, cmd.role, cmd.companyId, cmd.bps, cmd.rounds, cmd.price); break;
    case 'WithdrawOffer': withdrawOffer(ctx, seat, cmd.offerId); break;
    case 'ListAuction': listAuction(ctx, seat, cmd.asset, cmd.reserve); break;
    case 'Tender': at(s, seat, 'wallstreet', 'Launching a tender'); launchTender(ctx, seat, cmd.companyId, cmd.price, cmd.maxShares, cmd.minShares); break;
    case 'EndTurn': endTurn(ctx); return;
    default: reject('not_now', 'That action is not available during your turn.');
  }
  s.apRemaining -= cost;
}

function rescueCommand(ctx: Ctx, seat: SeatId, cmd: Command): void {
  let force = false;
  switch (cmd.type) {
    case 'MarketOrder': marketOrder(ctx, seat, cmd.companyId, cmd.shares, true); break;
    case 'SellAsset':
      if (cmd.asset.kind === 'business') sellBusiness(ctx, seat, cmd.asset.companyId, cmd.asset.units, true);
      else sellProperty(ctx, seat, cmd.asset.propertyId, true);
      break;
    case 'Repay': repay(ctx, seat, cmd.loanId, cmd.amount); break;
    case 'Refinance': refinance(ctx, seat, cmd.loanId, cmd.term, cmd.rateType); break;
    case 'ProposeTrade': proposeTrade(ctx, seat, cmd.recipient, cmd.give, cmd.receive, cmd.note); break;
    case 'ProposeLoan': proposeLoan(ctx, seat, cmd.recipient, cmd.role, cmd.principal, cmd.rate, cmd.term, cmd.collateral); break;
    case 'ProposeRights': proposeRights(ctx, seat, cmd.recipient, cmd.role, cmd.companyId, cmd.bps, cmd.rounds, cmd.price); break;
    case 'Restructure': case 'EndTurn': force = true; break;
    default: reject('rescue_only', 'During a rescue you can only sell, repay, refinance, propose a rescue deal or restructure.');
  }
  afterRescueDecision(ctx, seat, force);
}

function run(ctx: Ctx, actor: SeatId | 'system', cmd: Command): void {
  const s = ctx.s;
  if (s.phase === 'finished') reject('finished', 'The match is over.');
  const prompt = currentPrompt(s);
  if (prompt.kind === 'none') reject('not_now', 'Nothing is waiting for input.');
  if (cmd.type === 'TimeoutTurn') {
    if (actor !== 'system') reject('forbidden', 'Only the host clock can time a seat out.');
    const seat = prompt.seat;
    emit(ctx, 'timeout', `${s.players[seat].name} ran out of time.`, { seat });
    if (prompt.kind === 'turn') endTurn(ctx);
    else if (prompt.kind === 'offer') { rejectOffer(ctx, seat, prompt.offerId); if (s.phase === 'distress') afterRescueResponse(ctx); }
    else if (prompt.kind === 'tender') tenderResponse(ctx, seat, 0);
    else if (prompt.kind === 'auction') passAuction(ctx, seat);
    else afterRescueDecision(ctx, seat, true);
    advance(ctx);
    return;
  }
  if (actor === 'system' || !s.players[actor]) reject('forbidden', 'Unknown seat.');
  if (prompt.seat !== actor) reject('not_your_turn', `Waiting for ${s.players[prompt.seat].name}.`);
  switch (prompt.kind) {
    case 'turn': turnCommand(ctx, actor, cmd); break;
    case 'offer':
      if (cmd.type === 'AcceptOffer') acceptOffer(ctx, actor, cmd.offerId);
      else if (cmd.type === 'RejectOffer') rejectOffer(ctx, actor, cmd.offerId);
      else reject('respond_first', 'Answer the proposal first: accept or reject.');
      if (s.phase === 'distress') afterRescueResponse(ctx);
      break;
    case 'tender':
      if (cmd.type !== 'TenderResponse') reject('respond_first', 'Answer the tender offer first.');
      tenderResponse(ctx, actor, cmd.shares);
      break;
    case 'auction':
      if (cmd.type === 'Bid') bid(ctx, actor, cmd.amount);
      else if (cmd.type === 'PassAuction') passAuction(ctx, actor);
      else reject('respond_first', 'Bid or pass.');
      break;
    case 'rescue': rescueCommand(ctx, actor, cmd); break;
  }
  advance(ctx);
}

function execute(state: MatchState, env: CommandEnvelope, dry: boolean): ApplyResult {
  const fail = (code: string, message: string): ApplyResult => ({ ok: false, state, events: [], error: { code, message } });
  if (env.matchId !== state.matchId) return fail('wrong_match', 'This command belongs to a different match.');
  if (env.rulesVersion !== state.rulesVersion) return fail('wrong_rules', 'Rules version mismatch.');
  if (env.expectedRevision !== state.revision) return fail('stale', 'The game moved on. Review the new state and try again.');
  if (!env.command || typeof env.command !== 'object' || typeof env.command.type !== 'string') return fail('bad_command', 'Malformed command.');
  const ctx: Ctx = { s: cloneState(state), events: [], dry };
  ctx.s.revision += 1;
  try {
    run(ctx, env.actorId, env.command);
  } catch (e) {
    if (e instanceof RuleError) return fail(e.code, e.message);
    throw e;
  }
  for (const seat of ctx.s.seatOrder) trackMinCash(ctx.s, seat);
  return { ok: true, state: ctx.s, events: ctx.events };
}

/** Apply one command. Rejections return the original state untouched (same revision, same RNG). */
export function applyCommand(state: MatchState, env: CommandEnvelope): ApplyResult {
  return execute(state, env, false);
}

/** Dry-run a command (works on observations too: hidden draws are skipped). */
export function validateCommand(state: MatchState, env: CommandEnvelope): { ok: boolean; error?: { code: string; message: string } } {
  const r = execute(state, env, true);
  return { ok: r.ok, error: r.error };
}

/** No-op unless the state is mid automatic phase; kept for hosts that persist between phases. */
export function advanceAutomaticPhase(state: MatchState): { state: MatchState; events: GameEvent[] } {
  if (state.phase === 'finished' || currentPrompt(state).kind !== 'none') return { state, events: [] };
  const ctx: Ctx = { s: cloneState(state), events: [], dry: false };
  ctx.s.revision += 1;
  advance(ctx);
  return { state: ctx.s, events: ctx.events };
}

export function envelope(state: MatchState, actorId: SeatId | 'system', command: Command, commandId: string): CommandEnvelope {
  return { matchId: state.matchId, commandId, actorId, expectedRevision: state.revision, rulesVersion: state.rulesVersion, command };
}

export function replay(initial: MatchState, commands: CommandEnvelope[]): MatchState {
  let s = initial;
  for (const env of commands) {
    const r = applyCommand(s, env);
    if (!r.ok) throw new Error(`replay rejected ${env.commandId}: ${r.error?.message}`);
    s = r.state;
  }
  return s;
}

export function stateHash(state: MatchState): string {
  return sha256Hex(canonical({ ...state, content: state.content.version }));
}

export interface SeatObservation { seat: SeatId | null; state: MatchState }

export function eventVisibleTo(ev: GameEvent, seat: SeatId | null): boolean {
  return !ev.visibleTo || (seat !== null && ev.visibleTo.includes(seat));
}

/** Seat-filtered projection: no RNG, no pending news, no opponents' research, no private offers or journal. */
export function getObservation(state: MatchState, seat: SeatId | null): SeatObservation {
  const s = cloneState(state);
  s.rng = {};
  s.hidden = { pendingRegime: null, pendingEvents: [], pendingShift: null, sectorDemand: zeroDemand() };
  s.journal = [];
  s.log = s.log.filter((e) => eventVisibleTo(e, seat));
  for (const p of Object.values(s.players)) if (p.id !== seat) p.research = [];
  for (const [id, o] of Object.entries(s.offers)) if (o.status !== 'accepted' && o.proposer !== seat && o.recipient !== seat) delete s.offers[id];
  return { seat, state: s };
}

export function projectEvents(events: GameEvent[], seat: SeatId | null): GameEvent[] {
  return events.filter((e) => eventVisibleTo(e, seat));
}

export interface ActionDescriptor { type: CommandType; apCost: number; enabled: boolean; reason?: string }

/** Coarse per-type availability for the observing seat (used for buttons and AI candidate pruning). */
export function listLegalActions(obs: SeatObservation): ActionDescriptor[] {
  const s = obs.state;
  const seat = obs.seat;
  const prompt = currentPrompt(s);
  if (!seat || s.phase === 'finished' || prompt.kind === 'none' || prompt.seat !== seat) return [];
  const mk = (type: CommandType, enabled = true, reason?: string): ActionDescriptor => ({ type, apCost: prompt.kind === 'turn' ? apCost(type) : 0, enabled, reason });
  if (prompt.kind === 'offer') return [mk('AcceptOffer'), mk('RejectOffer')];
  if (prompt.kind === 'tender') return [mk('TenderResponse')];
  if (prompt.kind === 'auction') return [mk('Bid'), mk('PassAuction')];
  if (prompt.kind === 'rescue') return (['MarketOrder', 'SellAsset', 'Repay', 'Refinance', 'ProposeTrade', 'ProposeLoan', 'ProposeRights', 'Restructure'] as CommandType[]).map((t) => mk(t));
  const d = s.players[seat].district;
  const ap = s.apRemaining > 0;
  const need = (ok: boolean, where: string) => (ap ? (ok ? undefined : `Go to ${where}.`) : 'No action points left.');
  const loc = (type: CommandType, ok: boolean, where: string) => mk(type, ap && ok, need(ok, where));
  const hasBiz = s.content.companies.some((c) => c.kind === 'private' && c.district === d);
  const hasProp = s.content.properties.some((p) => p.district === d);
  return [
    mk('Move', ap, ap ? undefined : 'No action points left.'),
    loc('MarketOrder', d === 'wallstreet', 'Wall Street'), loc('Tender', d === 'wallstreet', 'Wall Street'),
    loc('Research', d === 'wallstreet' || s.content.companies.some((c) => c.district === d), 'Wall Street or a sector district'),
    loc('Borrow', d === 'financial', 'Financial'), loc('Refinance', d === 'financial', 'Financial'), loc('BuildRelationship', d === 'financial', 'Financial'),
    loc('BuyAsset', hasBiz || hasProp, 'a district with assets for sale'), loc('SellAsset', hasBiz || hasProp, 'the asset\'s district'),
    loc('Upgrade', hasProp, 'the property\'s district'),
    loc('SetPolicy', s.content.companies.some((c) => c.district === d && s.control[c.id] === seat), 'the district of a company you control'),
    mk('Repay', ap), mk('ProposeTrade', ap), mk('ProposeLoan', ap), mk('ProposeRights', ap), mk('ListAuction', ap), mk('WithdrawOffer'), mk('EndTurn'),
  ];
}

export interface AuditReport { ok: boolean; problems: string[] }

/** Conservation and consistency checks used by tests, the simulator and the replay audit tool. */
export function auditState(s: MatchState): AuditReport {
  const problems: string[] = [];
  for (const def of s.content.companies) {
    const book = s.ownership.units[def.id] ?? {};
    const total = Object.values(book).reduce((a, b) => a + b, 0);
    if (total !== def.sharesOutstanding) problems.push(`units of ${def.id} sum to ${total}`);
    if (Object.values(book).some((n) => n < 0 || !Number.isSafeInteger(n))) problems.push(`negative units in ${def.id}`);
    if (s.companies[def.id].cash < 0) problems.push(`negative company cash ${def.id}`);
  }
  let cash = s.bankCash + s.economyCash;
  for (const c of Object.values(s.companies)) cash += c.cash;
  for (const p of Object.values(s.players)) {
    cash += p.cash;
    if (p.cash < 0) problems.push(`negative cash ${p.id}`);
    if (reservedCash(s, p.id) < 0) problems.push(`negative reserved cash ${p.id}`);
    if (spendable(s, p.id) < 0 && s.phase !== 'finished') problems.push(`reservations exceed cash ${p.id}`);
    if (totalArrears(s, p.id) < 0) problems.push(`negative arrears ${p.id}`);
  }
  const initial = s.seatOrder.length * STARTING_CASH + s.content.companies.reduce((a, c) => a + c.initialCash, 0);
  if (cash !== initial) problems.push(`cash not conserved: ${cash} vs ${initial}`);
  for (const j of s.journal) if (j.lines.reduce((a, l) => a + l.delta, 0) !== 0) problems.push(`unbalanced journal entry ${j.id}`);
  for (const l of Object.values(s.loans)) if (l.principal < 0 || l.arrears < 0) problems.push(`negative loan balance ${l.id}`);
  for (const t of Object.values(s.ownership.titles)) if (t !== 'bank' && !s.players[t]) problems.push('title held by unknown seat');
  return { ok: problems.length === 0, problems };
}
