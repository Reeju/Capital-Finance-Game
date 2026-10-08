import { content, validateContent } from '@capital/content';
import { createMatch, valueCompany, fmtUsd } from '@capital/engine';

validateContent(content);
const s = createMatch({ matchId: 'validate', totalRounds: 12, scenario: 'normal', seats: [{ id: 'a', name: 'A', color: '#000', kind: 'human' }, { id: 'b', name: 'B', color: '#000', kind: 'human' }] }, 'validate', content);
for (const c of content.companies) console.log(`${c.ticker.padEnd(5)} ${c.name.padEnd(20)} equity ${fmtUsd(valueCompany(s, c.id).equity)}`);
console.log(`content ${content.version} OK: ${content.companies.length} companies, ${content.properties.length} properties, ${content.events.length} events`);
