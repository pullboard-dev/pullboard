/** A worker whose pull-mode job folder was removed ends itself, so its holds free for the line behind it [C7,#5593]. */
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/**
 * Watch the job folder the runner agent gave this worker (PULLBOARD_QUEUE_JOB). When it disappears nobody can read the
 * result, so treat it as a lost transport: stop owned work, release the leases in cleanup, and exit within a minute.
 * Why: on 11 Nov an orphan held a never-expiring source-cache pin for 28 minutes while 14 jobs waited behind it.
 * The watch is a file event, not a poll, and does not keep the process alive.
 *
 * @param {object} S - Worker state.
 * @param {{ folder?: string, graceMs?: number, exit?: (code: number) => void }} [options]
 * @returns {{ stop: () => void, finish: () => void }} stop ends the watch; finish also cancels the exit deadline.
 */
export function watchJobFolder(S, { folder = environmentAdapter().get('PULLBOARD_QUEUE_JOB'), graceMs = 30_000, exit = code => process.exit(code) } = {}) {
  let deadline = null;
  let watcher = null;
  const stop = () => { watcher?.close(); watcher = null; };
  const finish = () => { stop(); clearTimeout(deadline); };
  const gone = () => {
    if (fs.exists(folder) || deadline) return;
    stop();
    process.stderr.write(`PULLBOARD_RUNNER_ORPHAN ${S.workerId} job folder removed\n`);
    S.transportDrop();
    // Cleanup normally ends the process first; this stops a worker stuck in cleanup from holding its leases on.
    deadline = setTimeout(() => exit(1), graceMs);
  };
  try {
    if (folder) {
      watcher = fs.watch(folder, { persistent: false }, gone);
      watcher.on('error', gone);
    }
  } catch { gone(); }
  return { stop, finish };
}
