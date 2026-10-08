import { content } from '@capital/content';
import { type Command, type DistrictId, type MatchState, type SeatId, applyCommand, auditState, createMatch, currentPrompt, envelope } from '../index';

let n = 0;
export function newMatch(seats = 2, rounds: 12 | 20 = 12, seed = 'test', scenario: 'normal' | 'tutorial' = 'normal'): MatchState {
  return createMatch({
    matchId: 'm1', totalRounds: rounds, scenario,
    seats: Array.from({ length: seats }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}`, color: '#000', kind: 'human' as const })),
  }, seed, content);
}

/** Apply a command that must succeed; audits conservation after every step. */
export function act(s: MatchState, seat: SeatId | 'system', command: Command): MatchState {
  const r = applyCommand(s, envelope(s, seat, command, `t${n++}`));
  if (!r.ok) throw new Error(`rejected ${command.type}: ${r.error?.code} ${r.error?.message}`);
  const a = auditState(r.state);
  if (!a.ok) throw new Error(a.problems.join('; '));
  return r.state;
}

export function tryAct(s: MatchState, seat: SeatId | 'system', command: Command) {
  return applyCommand(s, envelope(s, seat, command, `t${n++}`));
}

/** Give the default answer to whoever is prompted: end turn, pass, decline. */
export function passOnce(s: MatchState): MatchState {
  const p = currentPrompt(s);
  if (p.kind === 'none') throw new Error('nobody to act');
  if (p.kind === 'offer') return act(s, p.seat, { type: 'RejectOffer', offerId: p.offerId });
  if (p.kind === 'tender') return act(s, p.seat, { type: 'TenderResponse', shares: 0 });
  if (p.kind === 'auction') return act(s, p.seat, { type: 'PassAuction' });
  return act(s, p.seat, { type: 'EndTurn' });
}

export function passUntil(s: MatchState, pred: (s: MatchState) => boolean): MatchState {
  for (let i = 0; i < 2000 && !pred(s); i++) {
    if (s.phase === 'finished') throw new Error('match finished before condition');
    s = passOnce(s);
  }
  return s;
}

export function toRound(s: MatchState, round: number): MatchState {
  return passUntil(s, (x) => x.round >= round && x.phase === 'turns');
}

export function toTurnOf(s: MatchState, seat: SeatId): MatchState {
  return passUntil(s, (x) => x.phase === 'turns' && x.activeSeat === seat);
}

/** Test-only edit of a cloned state (bypasses rules; conservation is the caller's problem). */
export function patch(s: MatchState, f: (d: MatchState) => void): MatchState {
  const d = structuredClone(s);
  f(d);
  return d;
}

/** Hand units from the bank float to a seat for free (test setup). */
export function giveUnits(s: MatchState, seat: SeatId, companyId: string, units: number): MatchState {
  return patch(s, (d) => {
    d.ownership.units[companyId].bank -= units;
    d.ownership.units[companyId][seat] = (d.ownership.units[companyId][seat] ?? 0) + units;
    const total = d.content.companies.find((c) => c.id === companyId)?.sharesOutstanding ?? 0;
    d.control[companyId] = d.seatOrder.find((x) => (d.ownership.units[companyId][x] ?? 0) * 2 > total) ?? null;
  });
}

export function goTo(s: MatchState, seat: SeatId, path: DistrictId[]): MatchState {
  for (const to of path) s = act(s, seat, { type: 'Move', to });
  return s;
}

export function promptSeat(s: MatchState): SeatId {
  const p = currentPrompt(s);
  if (p.kind === 'none') throw new Error('nobody to act');
  return p.seat;
}
