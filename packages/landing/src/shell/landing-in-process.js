/** Run one landing batch in the landing command's own process, the drive-cell path that replaces bin/landing-worker.js [C7]. */
import { Refused } from '../../../kernel/index.js';
import { assertWorkerFence } from './landing-worker.js';

/** The environment a batch's spawned runs and Git calls see, the same the landing worker process set for itself. */
const LANDING_ENV = { PULLBOARD_LANDING_CLASS: '1', GIT_OPTIONAL_LOCKS: '0' };

/**
 * Set the landing environment for the length of one batch and put back what was there before.
 *
 * Why: the worker process set these for every run it spawned (comparisons and bisection halves wait in the slot
 * line as a landing, and Git takes no optional locks), so an in-process batch must give its children the same.
 *
 * @param {() => Promise<any>} work
 * @returns {Promise<any>}
 */
async function withLandingEnv(work) {
  const before = Object.fromEntries(Object.keys(LANDING_ENV).map(name => [name, process.env[name]]));
  Object.assign(process.env, LANDING_ENV);
  try { return await work(); }
  finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The board writes a batch may ask for, the same narrow list the landing worker's parent allowed. */
const BATCH_WRITES = new Set(['recordTrainLanding', 'recordLandingBatch', 'finishLandingBatch', 'recordLandingFlake', 'recordLandingTestDefect',
  'recordFlakeObservation', 'recordGateRun', 'reopen', 'appendFact', 'holdItem', 'releaseItemHold', 'shout']);

/**
 * The batch runner `land` calls in place of runLandingWorker: it runs runLandingBatch here, with the same options,
 * ports, write list and lease checks the worker process had, so every landing the worker did still happens.
 *
 * Why: the worker was a spawned guardian and worker pair talking over IPC; the drive cell runs landing as a job in
 * the command's own process, so writes, waits and lines go straight to the parent's handlers.
 *
 * The board and ports come from `land` itself, so the batch sees the canonical operation ports `land` checked, the
 * same twelve the worker composed, and never the command's post-land suite port, which the worker never had.
 *
 * @param {{ checkAtCommit: Function, candidateWorkerFile: string }} parts - The runner's checkAtCommit and the
 *   candidate worker file.
 * @returns {(options: object, hooks: { board: object, landingPorts: object, write: Function, checkLease: Function,
 *   checkLeaseNow: Function, onWait?: Function, say: Function, signal?: AbortSignal }) => Promise<object>}
 */
export function inProcessLandingBatch({ checkAtCommit, candidateWorkerFile }) {
  return async (options, { board, landingPorts, write, checkLease, checkLeaseNow, onWait, say, signal }) => {
    const { runLandingBatch } = await import('./land.js');
    /** A lost lease stops the batch at its next board call, as the worker's parent refused calls after an abort. */
    const live = () => { if (signal?.aborted) throw signal.reason; };
    const fence = () => assertWorkerFence(board, options.fence, options.root);
    return withLandingEnv(() => runLandingBatch({ ...options, board, checkAtCommit, candidateWorkerFile, landingPorts, say,
      write: async (operation, args) => {
        live();
        if (!BATCH_WRITES.has(operation)) throw new Refused('LAND_WORKER', 'the landing batch requested an unsupported operation; stop it and inspect pullboard resume');
        return write(operation, args);
      },
      onWait: async state => { live(); return onWait?.(state); },
      // The fence re-reads Git facts itself, as the worker's did after each parent check.
      checkLease: async () => { live(); await checkLease(); checkLeaseNow(); fence(); },
      checkLeaseNow: fence }));
  };
}
