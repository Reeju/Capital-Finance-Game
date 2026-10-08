// Headless match runner shared by the simulator, balance report and tests.
import { chooseAction } from '@capital/ai';
import { content } from '@capital/content';
import {
  type Archetype, type Command, type CommandEnvelope, type MatchState, type SeatObservation, applyCommand, auditState, bankAskProperty, createMatch,
  currentPrompt, envelope, getObservation, spendable, unitsOf, valueCompany,
} from '@capital/engine';

export type PolicyName = Archetype | 'cash' | 'stocks' | 'property';
export type Policy = (obs: SeatObservation) => Command;

const passive = (obs: SeatObservation): Command => {
  const p = currentPrompt(obs.state);
  if (p.kind === 'offer') return { type: 'RejectOffer', offerId: p.offerId };
  if (p.kind === 'tender') return { type: 'TenderResponse', shares: 0 };
  if (p.kind === 'auction') return { type: 'PassAuction' };
  if (p.kind === 'rescue') return { type: 'Restructure' };
  return { type: 'EndTurn' };
};

/** Baseline: walk to Wall Street and keep buying the whole market evenly, never borrowing. */
const stocksOnly: Policy = (obs) => {
  const s = obs.state;
  const seat = obs.seat as string;
  if (currentPrompt(s).kind !== 'turn' || s.apRemaining <= 0) return passive(obs);
  if (s.players[seat].district !== 'wallstreet') return { type: 'Move', to: 'wallstreet' };
  const pubs = s.content.companies.filter((c) => c.kind === 'public');
  const pick = [...pubs].sort((a, b) => unitsOf(s, seat, a.id) * valueCompany(s, a.id).mark - unitsOf(s, seat, b.id) * valueCompany(s, b.id).mark)[0];
  const mark = valueCompany(s, pick.id).mark;
  const n = Math.min(unitsOf(s, 'bank', pick.id), 1000, Math.floor((spendable(s, seat) - 20_000_00) / (mark * 1.05)));
  return n >= 10 ? { type: 'MarketOrder', companyId: pick.id, shares: n } : { type: 'EndTurn' };
};

/** Baseline: buy any bank property it can afford, cash only. */
const propertyOnly: Policy = (obs) => {
  const s = obs.state;
  const seat = obs.seat as string;
  if (currentPrompt(s).kind !== 'turn' || s.apRemaining <= 0) return passive(obs);
  const target = s.content.properties.find((p) => s.ownership.titles[p.id] === 'bank' && bankAskProperty(s, p.id) <= spendable(s, seat) - 10_000_00 && s.auction?.asset.kind !== 'property');
  if (!target) return { type: 'EndTurn' };
  const here = s.players[seat].district;
  if (here === target.district) return { type: 'BuyAsset', asset: { kind: 'property', propertyId: target.id } };
  if (target.district === 'realestate') return { type: 'Move', to: here === 'financial' || here === 'downtown' || here === 'energy' ? 'realestate' : 'financial' };
  return { type: 'Move', to: here === 'financial' || here === 'realestate' ? 'downtown' : 'financial' };
};

export function policyFor(name: PolicyName): Policy {
  if (name === 'cash') return passive;
  if (name === 'stocks') return stocksOnly;
  if (name === 'property') return propertyOnly;
  return (obs) => chooseAction(obs, name)?.command ?? { type: 'EndTurn' };
}

export interface RunOptions { seed: string; rounds: 12 | 20; policies: PolicyName[]; audit?: boolean; scenario?: 'normal' | 'tutorial' }
export interface RunOutput { state: MatchState; initial: MatchState; commands: CommandEnvelope[]; rejected: number; noActionTurns: number; turns: number }

export function runMatch(opts: RunOptions): RunOutput {
  const seats = opts.policies.map((p, i) => ({ id: `s${i + 1}`, name: `${p}-${i + 1}`, color: '#888', kind: 'ai' as const, archetype: (p === 'grace' || p === 'alex' || p === 'victor' ? p : undefined) }));
  const initial = createMatch({ matchId: `sim-${opts.seed}`, totalRounds: opts.rounds, seats, scenario: opts.scenario ?? 'normal' }, opts.seed, content);
  let s = initial;
  const commands: CommandEnvelope[] = [];
  let rejected = 0;
  let noActionTurns = 0;
  let turns = 0;
  let actedThisTurn = false;
  for (let i = 0; s.phase !== 'finished'; i++) {
    if (i > 20_000) throw new Error(`match ${opts.seed} did not finish`);
    const prompt = currentPrompt(s);
    if (prompt.kind === 'none') throw new Error('engine is waiting on nobody');
    const idx = s.seatOrder.indexOf(prompt.seat);
    let cmd = policyFor(opts.policies[idx])(getObservation(s, prompt.seat));
    let env = envelope(s, prompt.seat, cmd, `c${i}`);
    let r = applyCommand(s, env);
    if (!r.ok) {
      rejected++;
      if (process.env.SIM_DEBUG) console.error(opts.seed, opts.policies[idx], JSON.stringify(cmd), r.error?.message);
      cmd = passive(getObservation(s, prompt.seat));
      env = envelope(s, prompt.seat, cmd, `c${i}`);
      r = applyCommand(s, env);
      if (!r.ok) throw new Error(`fallback rejected: ${r.error?.message}`);
    }
    if (prompt.kind === 'turn') {
      if (cmd.type === 'EndTurn') {
        turns++;
        if (!actedThisTurn) noActionTurns++;
        actedThisTurn = false;
      } else actedThisTurn = true;
    }
    commands.push(env);
    s = r.state;
    if (opts.audit) {
      const a = auditState(s);
      if (!a.ok) throw new Error(`audit failed in ${opts.seed} after ${JSON.stringify(cmd)}: ${a.problems.join('; ')}`);
    }
  }
  return { state: s, initial, commands, rejected, noActionTurns, turns };
}
