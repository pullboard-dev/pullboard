/** @pullboard-module-loads src/submit-handoff-worker.js */
/** The native hook worker process: the seats cell's hook order composed with CLI and board steps [I6,C7]. */
import { fileURLToPath } from 'node:url';
import { work } from '../packages/seats/index.js';

/** Refresh only the private presence sidecar before ordinary read-only context. */
async function heartbeat() {
  const { heartbeatCommand } = await import('./cli-presence.js');
  heartbeatCommand({ cwd: process.cwd(), err: text => process.stderr.write(text + '\n') });
}

/** Dispatch one native CLI command under the worker's own process streams. */
async function dispatch(args) {
  const { main } = await import('./cli.js');
  const { launchRelaySender } = await import('./relay-sender-main.js');
  return main(args, { cwd: process.cwd(), nextActions: false,
    loadNativeBoard: () => import('./native-board.js'), hookWorker: HOOK_WORKER,
    submitHandoffWorker: fileURLToPath(new URL('./submit-handoff-worker.js', import.meta.url)), launchRelaySender,
    // Heartbeat is an internal observation, not part of the hook's context payload.
    stdout: args[0] === 'heartbeat' ? { write() {} } : process.stdout,
    stderr: process.stderr, stdin: process.stdin });
}

/** Warn only when committed work has advanced beyond this seat's recorded claim head. */
async function inspect() {
  const { repoInfo, headCommit, tryGit } = await import('./git.js');
  const { join } = await import('node:path');
  const store = await import('./board.js');
  const { openBoardForRead } = await import('./native-board.js');
  const info = repoInfo(process.cwd());
  const board = openBoardForRead(join(info.commonDir, 'pullboard', 'board.sqlite'));
  if (!board) return;
  try {
    const agent = store.agentAt(board, info.root), head = headCommit(info.root);
    if (!agent || !head) return;
    const items = store.listItems(board, { all: true }).filter(item => item.item_status === 'claimed'
      && item.item_owner === agent.agent_id && item.item_claim_head && item.item_claim_head !== head
      && tryGit(info.root, ['merge-base', '--is-ancestor', item.item_claim_head, head]).status === 0
      && tryGit(info.root, ['diff', '--quiet', item.item_claim_head, head, '--']).status === 1);
    if (items.length) process.stdout.write(`Committed work on ${items.map(item => '#' + item.item_id).join(', ')} is not submitted. Run pullboard submit <id> --wait when it is ready.\n`);
  } finally { store.closeBoard(board); }
}

/** The path the hook runner spawns; the CLI passes it to the seats cell's runner. */
export const HOOK_WORKER = fileURLToPath(import.meta.url);

if (process.argv[1] === HOOK_WORKER) {
  try { await work(process.argv[2], { heartbeat, dispatch, inspect }); }
  catch { process.exitCode = 1; }
}
