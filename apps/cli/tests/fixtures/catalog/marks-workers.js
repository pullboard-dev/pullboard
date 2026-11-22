/**
 * The detached inbox marks workers the catalog's in-process CLI calls start, so the fixture can wait for them [C7,A1].
 * Why: inbox and decisions hand their delivery marks to a background worker that opens the case's board and exits; it is a
 * child of the test process, so removing the case's folder before it exits races its writes and holds the file past its exit limit.
 */
import { channel } from 'node:diagnostics_channel';

// Budget: a marks worker only opens one board and writes one batch; one still running after this is stopped.
const WORKER_MS = 20_000;
const workers = new Set();

channel('child_process').subscribe(({ process: child }) => {
  // The spawn arguments are set after the channel publishes, so read them once the spawn call has returned.
  queueMicrotask(() => {
    if (!String(child.spawnargs?.[1] ?? '').endsWith('inbox-marks-worker.js')) return;
    workers.add(child);
    child.once('close', () => workers.delete(child));
  });
});

/** Wait until every marks worker started so far has exited, stopping one that outlives its budget. */
export async function settleMarksWorkers() {
  await Promise.all([...workers].map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), WORKER_MS);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  })));
}
