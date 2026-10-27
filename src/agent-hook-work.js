/** Read ordinary local work for a native nudge; the parent bounds this whole worker [I6]. */
import { fileURLToPath } from 'node:url';

/** Native hook activity refreshes only the private sidecar before ordinary read-only context. */
async function work(event) {
  const { heartbeatCommand } = await import('./cli-presence.js');
  try { heartbeatCommand({ cwd: process.cwd(), err: text => process.stderr.write(text + '\n') }); }
  catch { /* A failed private observation must not suppress the ordinary native context. */ }
  if (event === 'SessionEnd') return;
  // This explicit native heartbeat may claim work; ordinary read commands never do.
  const { main: dispatch } = await import('./cli.js');
  await dispatch(['heartbeat'], { cwd: process.cwd(),
    stdout: process.stdout, stderr: process.stderr, stdin: process.stdin });
  if (event === 'SessionStart') {
    const { main } = await import('./cli.js');
    process.exitCode = await main(['resume'], { cwd: process.cwd(),
      stdout: process.stdout, stderr: process.stderr, stdin: process.stdin });
    return;
  }
  const { repoInfo, headCommit, tryGit } = await import('./git.js');
  const { join } = await import('node:path');
  const store = await import('./board.js');
  const info = repoInfo(process.cwd());
  const board = store.openBoardForRead(join(info.commonDir, 'pullboard', 'board.sqlite'));
  if (!board) return;
  try {
    const agent = store.agentAt(board, info.root), head = headCommit(info.root);
    if (!agent || !head) return;
    const items = store.listItems(board, { all: true }).filter(item => item.item_status === 'claimed'
      && item.item_owner === agent.agent_id && item.item_claim_head && item.item_claim_head !== head
      && tryGit(info.root, ['merge-base', '--is-ancestor', item.item_claim_head, head]).status === 0
      && tryGit(info.root, ['diff', '--quiet', item.item_claim_head, head, '--']).status === 1);
    if (items.length) process.stdout.write(`Committed work on ${items.map(item => '#' + item.item_id).join(', ')} is not submitted. Run pullboard submit <id> when it is ready.\n`);
  } finally { store.closeBoard(board); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await work(process.argv[2]); }
  catch { process.exitCode = 1; }
}
