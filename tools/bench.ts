// Performance check against the spec budgets: pnpm exec tsx tools/bench.ts
import { chooseAction } from '@capital/ai';
import { applyCommand, currentPrompt, getObservation } from '@capital/engine';
import { runMatch } from './runner';

const out = runMatch({ seed: 'bench', rounds: 20, policies: ['grace', 'alex', 'victor', 'victor'] });
const cmd: number[] = [];
const close: number[] = [];
const ai: number[] = [];
let s = out.initial;
for (const env of out.commands) {
  const prompt = currentPrompt(s);
  if (prompt.kind !== 'none') {
    const t = performance.now();
    chooseAction(getObservation(s, prompt.seat));
    ai.push(performance.now() - t);
  }
  const round = s.round;
  const t0 = performance.now();
  const r = applyCommand(s, env);
  const dt = performance.now() - t0;
  (r.state.round !== round || r.state.phase === 'finished' ? close : cmd).push(dt);
  s = r.state;
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;
const max = (xs: number[]) => Math.max(...xs);
const snapshot = JSON.stringify(getObservation(s, s.seatOrder[0]).state).length;
console.log(JSON.stringify({
  commands: out.commands.length,
  commandP95Ms: Number(p95(cmd).toFixed(2)), commandMaxMs: Number(max(cmd).toFixed(2)),
  closeP95Ms: Number(p95(close).toFixed(2)), closeMaxMs: Number(max(close).toFixed(2)),
  aiP95Ms: Number(p95(ai).toFixed(2)), aiMaxMs: Number(max(ai).toFixed(2)),
  finalSnapshotBytes: snapshot, finalFullStateBytes: JSON.stringify(s).length,
  budgets: { commandP95Ms: 10, closeMs: 50, aiMsPerAp: 100, snapshotBytes: 250_000 },
}, null, 2));
