/** @pullboard-module-loads apps/cli/src/io/submit/handoff/worker.js apps/lib/index.js */
/** The native hook worker process: the seats cell's hook order composed with CLI and board steps [I6,C7]. */
import { fileURLToPath } from 'node:url';
import { work } from '../../../../../packages/seats/index.js';

/** Refresh only the private presence sidecar before ordinary read-only context. */
async function heartbeat() {
  const { heartbeatCommand } = await import('../presence.js');
  heartbeatCommand({ cwd: process.cwd(), err: text => process.stderr.write(text + '\n') });
}

/** Dispatch one native CLI command under the worker's own process streams. */
async function dispatch(args) {
  const { cli$main: main, launchRelaySender } = await import('../../../index.js');
  return main(args, { cwd: process.cwd(), nextActions: false,
    loadNativeBoard: () => import('../../../../lib/index.js'), hookWorker: HOOK_WORKER,
    submitHandoffWorker: fileURLToPath(new URL('../submit/handoff/worker.js', import.meta.url)), launchRelaySender,
    // Heartbeat is an internal observation, not part of the hook's context payload.
    stdout: args[0] === 'heartbeat' ? { write() {} } : process.stdout,
    stderr: process.stderr, stdin: process.stdin });
}

/** Warn only when committed work has advanced beyond this seat's recorded claim head. */
async function inspect() {
  const { repoInfo, headCommit, tryGit } = await import('../../../../../packages/git/index.js');
  const { warnUnsubmittedWork } = await import('../../../../lib/index.js');
  const info = repoInfo(process.cwd()), head = headCommit(info.root);
  warnUnsubmittedWork({ root: info.root, commonDir: info.commonDir, head, advanced: claimHead =>
    tryGit(info.root, ['merge-base', '--is-ancestor', claimHead, head]).status === 0
    && tryGit(info.root, ['diff', '--quiet', claimHead, head, '--']).status === 1 });
}

/** The path the hook runner spawns; the CLI passes it to the seats cell's runner. */
export const HOOK_WORKER = fileURLToPath(import.meta.url);

if (process.argv[1] === HOOK_WORKER) {
  // Dispatch can re-enter the lib front door; it must not hold this module's evaluation open.
  Promise.resolve().then(() => work(process.argv[2], { heartbeat, dispatch, inspect }))
    .catch(() => { process.exitCode = 1; });
}
