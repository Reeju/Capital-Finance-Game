// Property-based fuzzing, deterministic replay and AI-match invariants against the real engine.
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chooseAction } from '@capital/ai';
import { content, validateContent } from '@capital/content';
import {
  type Command, type MatchState, DISTRICTS, SECTORS, applyCommand, auditState, createMatch, currentPrompt, envelope, getObservation, replay, spendable,
  stateHash, unitsOf, valuePortfolio,
} from '@capital/engine';
import { runMatch } from '../../tools/runner';

const companies = content.companies.map((c) => c.id);
const props = content.properties.map((p) => p.id);
const seats = ['p1', 'p2', 'p3'];
const money = fc.integer({ min: -5, max: 700_000_00 });
const bundle = fc.record({ cash: fc.integer({ min: 0, max: 200_000_00 }), units: fc.dictionary(fc.constantFrom(...companies), fc.integer({ min: 0, max: 3000 }), { maxKeys: 2 }), properties: fc.subarray(props, { maxLength: 1 }) });
const pledge = fc.oneof(
  fc.record({ kind: fc.constant('units' as const), companyId: fc.constantFrom(...companies), units: fc.integer({ min: 1, max: 5000 }) }),
  fc.record({ kind: fc.constant('property' as const), propertyId: fc.constantFrom(...props) }),
);
const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ type: fc.constant('Move' as const), to: fc.constantFrom(...DISTRICTS) }) },
  { weight: 8, arbitrary: fc.record({ type: fc.constant('MarketOrder' as const), companyId: fc.constantFrom(...companies), shares: fc.integer({ min: -3000, max: 3000 }) }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant('Borrow' as const), principal: money, term: fc.constantFrom(3 as const, 5 as const), rateType: fc.constantFrom('fixed' as const, 'floating' as const), collateral: fc.array(pledge, { maxLength: 2 }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('Repay' as const), loanId: fc.constantFrom('L1', 'L2', 'L5', 'L9'), amount: money }) },
  { weight: 4, arbitrary: fc.record({ type: fc.constant('BuyAsset' as const), asset: fc.oneof(fc.record({ kind: fc.constant('business' as const), companyId: fc.constantFrom(...companies) }), fc.record({ kind: fc.constant('property' as const), propertyId: fc.constantFrom(...props) })) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('SellAsset' as const), asset: fc.oneof(fc.record({ kind: fc.constant('business' as const), companyId: fc.constantFrom(...companies), units: fc.integer({ min: 1, max: 10_000 }) }), fc.record({ kind: fc.constant('property' as const), propertyId: fc.constantFrom(...props) })) }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant('ProposeTrade' as const), recipient: fc.constantFrom(...seats), give: bundle, receive: bundle }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('ProposeLoan' as const), recipient: fc.constantFrom(...seats), role: fc.constantFrom('lender' as const, 'borrower' as const), principal: money, rate: fc.integer({ min: 0, max: 2500 }), term: fc.integer({ min: 0, max: 6 }), collateral: fc.array(pledge, { maxLength: 1 }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('ProposeRights' as const), recipient: fc.constantFrom(...seats), role: fc.constantFrom('buyer' as const, 'seller' as const), companyId: fc.constantFrom(...companies), bps: fc.integer({ min: 0, max: 12_000 }), rounds: fc.integer({ min: 1, max: 3 }), price: money }) },
  { weight: 4, arbitrary: fc.record({ type: fc.constant('AcceptOffer' as const), offerId: fc.constantFrom('O1', 'O2', 'O3', 'O4', 'O6', 'O8') }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('Bid' as const), amount: money }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('Tender' as const), companyId: fc.constantFrom(...companies), price: fc.integer({ min: 1, max: 300_00 }), maxShares: fc.integer({ min: 1, max: 6000 }), minShares: fc.integer({ min: 1, max: 6000 }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('TenderResponse' as const), shares: fc.integer({ min: -1, max: 4000 }) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('Research' as const), sector: fc.constantFrom(...SECTORS) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('SetPolicy' as const), companyId: fc.constantFrom(...companies), payout: fc.constantFrom(0, 2500, 5000, 7500, 9999) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('Reinvest' as const), companyId: fc.constantFrom(...companies), amount: money }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('ListAuction' as const), asset: fc.record({ kind: fc.constant('units' as const), companyId: fc.constantFrom(...companies), units: fc.integer({ min: 1, max: 3000 }) }), reserve: money }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('Upgrade' as const), propertyId: fc.constantFrom(...props) }) },
  { weight: 1, arbitrary: fc.constantFrom<Command>({ type: 'BuildRelationship' }, { type: 'Restructure' }, { type: 'PassAuction' }, { type: 'TimeoutTurn' }) },
  { weight: 5, arbitrary: fc.constant<Command>({ type: 'EndTurn' }) },
);

function fresh(seed: string): MatchState {
  return createMatch({ matchId: 'fuzz', totalRounds: 12, scenario: 'normal', seats: seats.map((id) => ({ id, name: id, color: '#000', kind: 'human' as const })) }, seed, content);
}

function checkInvariants(s: MatchState): void {
  const a = auditState(s);
  expect(a.problems).toEqual([]);
  for (const def of s.content.companies) expect(Object.values(s.ownership.units[def.id]).reduce((x, y) => x + y, 0)).toBe(def.sharesOutstanding);
  for (const seat of s.seatOrder) {
    if (s.phase !== 'finished') expect(spendable(s, seat)).toBeGreaterThanOrEqual(0);
    expect(s.players[seat].cash).toBeGreaterThanOrEqual(0);
    for (const def of s.content.companies) expect(unitsOf(s, seat, def.id)).toBeGreaterThanOrEqual(0);
  }
  if (s.phase !== 'finished') expect(currentPrompt(s).kind).not.toBe('none');
}

describe('fuzzed command sequences', () => {
  it('never crash, never break conservation and never mutate on rejection', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), fc.array(fc.tuple(command, fc.boolean()), { minLength: 20, maxLength: 160 }), (seedN, steps) => {
        let s = fresh(`fuzz-${seedN}`);
        let i = 0;
        for (const [cmd, wrongActor] of steps) {
          if (s.phase === 'finished') break;
          const prompt = currentPrompt(s);
          const actor = cmd.type === 'TimeoutTurn' ? 'system' : wrongActor && prompt.kind !== 'none' ? seats[(seats.indexOf(prompt.seat) + 1) % 3] : prompt.kind !== 'none' ? prompt.seat : 'p1';
          const before = s.revision;
          const r = applyCommand(s, envelope(s, actor, cmd, `f${i++}`));
          if (r.ok) expect(r.state.revision).toBe(before + 1);
          else {
            expect(r.state).toBe(s);
            expect(r.events).toEqual([]);
          }
          s = r.state;
          checkInvariants(s);
        }
      }),
      { numRuns: 150, seed: 20261008 },
    );
  });
});

describe('AI matches', () => {
  it('complete Quick and Standard games with audits on, and nobody is ever eliminated', () => {
    for (const [i, rounds] of ([12, 20, 12, 20] as const).entries()) {
      const out = runMatch({ seed: `ai-${i}`, rounds, policies: i % 2 ? ['victor', 'alex', 'grace', 'victor'] : ['grace', 'alex', 'victor'], audit: true });
      expect(out.state.phase).toBe('finished');
      expect(out.state.round).toBe(rounds);
      expect(out.rejected).toBe(0);
      expect(out.state.result?.rows).toHaveLength(out.state.seatOrder.length);
      for (const seat of out.state.seatOrder) expect(out.state.players[seat].history).toHaveLength(rounds);
    }
  });
  it('replay the accepted command log to the identical state hash', () => {
    const out = runMatch({ seed: 'replay-1', rounds: 12, policies: ['grace', 'alex', 'victor'] });
    expect(stateHash(replay(out.initial, out.commands))).toBe(stateHash(out.state));
    // a different seed diverges
    expect(stateHash(runMatch({ seed: 'replay-2', rounds: 12, policies: ['grace', 'alex', 'victor'] }).state)).not.toBe(stateHash(out.state));
  });
  it('matches the pinned golden replay fixture', () => {
    const out = runMatch({ seed: 'golden-1', rounds: 12, policies: ['grace', 'alex', 'victor'] });
    const golden = JSON.parse(readFileSync(new URL('../fixtures/golden-1.json', import.meta.url), 'utf8')) as { rulesVersion: string; contentVersion: string; commands: number; hash: string; netWorth: number[] };
    expect(out.state.rulesVersion).toBe(golden.rulesVersion);
    expect(out.state.contentVersion).toBe(golden.contentVersion);
    expect(out.commands.length).toBe(golden.commands);
    expect(out.state.seatOrder.map((x) => valuePortfolio(out.state, x).netWorth)).toEqual(golden.netWorth);
    expect(stateHash(out.state)).toBe(golden.hash);
  });
  it('AI decisions depend only on the seat observation', () => {
    const s = fresh('obs');
    const withSecrets = structuredClone(getObservation(s, 'p1'));
    const a = chooseAction({ ...withSecrets, state: { ...withSecrets.state, players: { ...withSecrets.state.players, p1: { ...withSecrets.state.players.p1, kind: 'ai', archetype: 'alex' } } } });
    expect(a).not.toBeNull();
    expect(withSecrets.state.rng).toEqual({});
  });
});

describe('content', () => {
  it('validates the shipped pack and rejects unknown metrics and bad bounds', () => {
    expect(() => validateContent(content)).not.toThrow();
    const bad = structuredClone(content) as unknown as { events: { modifiers: { metric: string }[] }[]; companies: { baseMargin: number }[] };
    bad.events[0].modifiers[0].metric = 'steal_company';
    expect(() => validateContent(bad)).toThrow();
    const bad2 = structuredClone(content);
    bad2.companies[0].baseMargin = 99_999;
    expect(() => validateContent(bad2)).toThrow();
    const bad3 = { ...structuredClone(content), script: 'alert(1)' };
    expect(() => validateContent(bad3)).toThrow();
  });
});
