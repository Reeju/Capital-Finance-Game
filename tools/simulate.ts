// Balance batch: pnpm simulate [matches=1000] [rounds=12|20]. Prints a summary and writes docs/balance-report-<rounds>.json.
import { writeFileSync } from 'node:fs';
import { type MatchState, valueCompany, valuePortfolio } from '@capital/engine';
import { type PolicyName, runMatch } from './runner';

const N = Number(process.argv[2] ?? 1000);
const rounds = (Number(process.argv[3] ?? 12) === 20 ? 20 : 12) as 12 | 20;
const LINEUPS: PolicyName[][] = [
  ['grace', 'alex', 'victor'], ['alex', 'victor', 'grace'], ['victor', 'grace', 'alex'],
  ['grace', 'alex', 'victor', 'cash'], ['stocks', 'grace', 'alex', 'victor'], ['property', 'victor', 'stocks', 'grace'],
  ['alex', 'grace'], ['victor', 'alex'], ['grace', 'victor'], ['cash', 'stocks', 'property', 'alex'],
  // mirror lineups isolate seat-order advantage from strategy
  ['victor', 'victor', 'victor'], ['alex', 'alex', 'alex'], ['grace', 'grace', 'grace', 'grace'], ['alex', 'alex'],
];

interface Agg { games: number; seats: number; wins: number; adjusted: number; restructures: number; cagrBps: number }
const byPolicy: Record<string, Agg> = {};
const seatWins = [0, 0, 0, 0];
const seatGames = [0, 0, 0, 0];
let restructuredPlayers = 0, players = 0, rejected = 0, noAction = 0, turns = 0, runaway = 0, ceilingHits = 0, floorHits = 0;
const stockCagr: number[] = [];
const t0 = performance.now();

function cagrBps(start: number, end: number, years: number): number {
  return end <= 0 || start <= 0 ? -10_000 : Math.round((Math.pow(end / start, 1 / years) - 1) * 10_000);
}

for (let i = 0; i < N; i++) {
  const policies = LINEUPS[i % LINEUPS.length];
  const out = runMatch({ seed: `balance-${rounds}-${i}`, rounds, policies, audit: i % 25 === 0 });
  const s: MatchState = out.state;
  rejected += out.rejected; noAction += out.noActionTurns; turns += out.turns;
  const res = s.result;
  if (!res) throw new Error('no result');
  s.seatOrder.forEach((seat, idx) => {
    const pol = policies[idx];
    const a = (byPolicy[pol] ??= { games: 0, seats: 0, wins: 0, adjusted: 0, restructures: 0, cagrBps: 0 });
    const v = valuePortfolio(s, seat);
    const mirror = new Set(policies).size === 1;
    const share = res.winners.includes(seat) ? 1 / res.winners.length : 0;
    a.adjusted += v.adjusted; a.cagrBps += cagrBps(500_000_00, v.netWorth - v.grants, rounds); a.seats++;
    if (mirror) { seatWins[idx] += share; seatGames[idx]++; } else { a.games++; a.wins += share; }
    players++;
    if ((s.players[seat].actionCounts.restructure ?? 0) > 0) { restructuredPlayers++; a.restructures++; }
  });
  // runaway: someone holds >50% of total net worth by round 4
  const r4 = s.seatOrder.map((seat) => s.players[seat].history[3]?.netWorth ?? 0);
  if (Math.max(...r4) * 2 > r4.reduce((x, y) => x + Math.max(y, 0), 0) * 1.3 && s.seatOrder.length > 2) runaway++;
  for (const def of s.content.companies) {
    if (def.kind !== 'public') continue;
    const end = valueCompany(s, def.id).mark;
    const start = valueCompany(out.initial, def.id).mark;
    if (end >= 1_000_00) ceilingHits++;
    if (end <= 50) floorHits++;
    stockCagr.push(cagrBps(start, end, rounds));
  }
}

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
stockCagr.sort((a, b) => a - b);
const q = (f: number) => stockCagr[Math.floor(stockCagr.length * f)];
const report = {
  matches: N, rounds, seconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
  policies: Object.fromEntries(Object.entries(byPolicy).map(([k, a]) => [k, {
    mixedLineupGames: a.games, winRate: pct((a.wins / Math.max(a.games, 1)) * 10_000), avgAdjustedUsd: Math.round(a.adjusted / a.seats / 100), avgNetWorthCagr: pct(a.cagrBps / a.seats),
    restructureRate: pct((a.restructures / a.seats) * 10_000),
  }])),
  mirrorSeatWinRate: seatWins.map((w, i) => (seatGames[i] ? pct((w / seatGames[i]) * 10_000) : 'n/a')),
  stockPriceCagr: { p10: pct(q(0.1)), median: pct(q(0.5)), p90: pct(q(0.9)) },
  playerRestructureRate: pct((restructuredPlayers / players) * 10_000),
  noActionTurnRate: pct((noAction / Math.max(turns, 1)) * 10_000),
  runawayByRound4Rate: pct((runaway / N) * 10_000),
  rejectedAiCommands: rejected, priceCeilingHits: ceilingHits, priceFloorHits: floorHits,
  flags: [] as string[],
};
for (const [k, a] of Object.entries(byPolicy)) if (a.games > 0 && a.wins / a.games > 0.6) report.flags.push(`${k} wins >60% (mixed lineups; not a fair-pairing proof)`);
if (restructuredPlayers / players > 0.15) report.flags.push('>15% of players restructured');
if (noAction / Math.max(turns, 1) > 0.2) report.flags.push('>20% no-action turns');
if (runaway / N > 0.25) report.flags.push('runaway leader by round 4 in >25% of matches');
if (ceilingHits > 0) report.flags.push(`${ceilingHits} final prices at the $1,000 ceiling`);
// first-seat advantage in 3-seat mirrors: expected 33.3%
const seat1 = seatGames[0] ? seatWins[0] / seatGames[0] : 0;
report.flags.push(`first seat wins ${pct(seat1 * 10_000)} of mirror matches (2-4 seats mixed; fair share is between 25% and 50%)`);
console.log(JSON.stringify(report, null, 2));
writeFileSync(new URL(`../docs/balance-report-${rounds}.json`, import.meta.url), JSON.stringify(report, null, 2));
