/**
 * The local runner's wake watcher: a command that offers a job touches one file in the local runner folder (wakeLocalRunner,
 * in local.js), and an idle runner pulling from that board claims at once instead of finishing its 2 s idle nap [P7,C7,#10409].
 *
 * Why a file: the offering command and the runner are separate processes on one machine, and a file in the runner's own
 * folder needs no port, no socket and nothing a remote runner would ever read.
 */
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WAKE_FILE } from './local.js';

/**
 * Watch the wake file: nap(ms) waits up to ms and ends early when the file is touched. A touch that lands while no nap
 * waits ends the next nap at once, so one that arrives mid-claim is not lost.
 *
 * @param {string} folder - The local runner folder.
 * @param {{ mark?: (step: 'touch' | 'wake' | 'timeout') => void, idle?: () => void }} [options] - idle is called each time a nap begins to wait, which is when a touch will end it; mark sees touch (a watch event), then wake (a nap ended early by it) or timeout (the timer ended the nap); absent, nothing changes.
 * @returns {{ nap: (ms: number) => Promise<void>, close: () => void }}
 */
export function watchWake(folder, { mark = () => {}, idle = () => {} } = {}) {
  const waiters = new Set();
  let pending = false, watcher = null;
  try {
    writeFileSync(join(folder, WAKE_FILE), '', { flag: 'a' });
    watcher = watch(folder, (_event, name) => {
      if (name !== null && String(name) !== WAKE_FILE) return;
      mark('touch');
      if (!waiters.size) { pending = true; return; }
      for (const done of [...waiters]) done('wake');
    });
    watcher.on('error', () => { /* the idle nap still finds the job */ });
  } catch { watcher = null; }
  return {
    nap: ms => {
      if (pending) { pending = false; mark('wake'); return Promise.resolve(); }
      return new Promise(resolve => {
        idle();
        const done = (step = 'timeout') => { clearTimeout(timer); waiters.delete(done); mark(step); resolve(); };
        const timer = setTimeout(done, ms);
        waiters.add(done);
      });
    },
    close: () => { watcher?.close(); for (const done of [...waiters]) done('wake'); },
  };
}
