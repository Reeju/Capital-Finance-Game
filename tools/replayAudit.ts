// Server determinism audit: pnpm exec tsx tools/replayAudit.ts [path/to/capital.sqlite]
// Replays every room's accepted command log from its initial state and compares hashes with the stored state.
import { auditState, replay, stateHash } from '@capital/engine';
import { Repository } from '../apps/server/src/repository';

const repo = new Repository(process.argv[2] ?? new URL('../apps/server/data/capital.sqlite', import.meta.url).pathname);
let bad = 0;
for (const row of repo.loadRooms()) {
  const m = repo.loadMatch(row.code);
  if (!m) continue;
  const cmds = repo.loadCommands(row.code);
  const replayed = replay(m.initial, cmds);
  const ok = stateHash(replayed) === stateHash(m.state) && auditState(m.state).ok;
  if (!ok) bad++;
  console.log(`${row.code}: ${cmds.length} commands, revision ${m.state.revision}, ${ok ? 'OK' : 'MISMATCH'}`);
}
repo.close();
process.exit(bad ? 1 : 0);
