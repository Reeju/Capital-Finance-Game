// Regenerate the golden replay fixture after an intentional rules/content change: tsx tools/makeGolden.ts
import { writeFileSync } from 'node:fs';
import { stateHash, valuePortfolio } from '@capital/engine';
import { runMatch } from './runner';

const out = runMatch({ seed: 'golden-1', rounds: 12, policies: ['grace', 'alex', 'victor'], audit: true });
const golden = {
  seed: 'golden-1', rulesVersion: out.state.rulesVersion, contentVersion: out.state.contentVersion, commands: out.commands.length,
  hash: stateHash(out.state), netWorth: out.state.seatOrder.map((x) => valuePortfolio(out.state, x).netWorth),
};
writeFileSync(new URL('../tests/fixtures/golden-1.json', import.meta.url), JSON.stringify(golden, null, 2));
console.log(golden);
