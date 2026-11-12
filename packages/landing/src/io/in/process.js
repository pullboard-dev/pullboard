/** Run one landing batch in the landing command's own process, the drive-cell path that replaces bin/landing-worker.js [C7]. */
import { statSync } from 'node:fs';
import { Refused } from '../../../../kernel/index.js';
import { assertWorkerFence } from '../worker.js';
import { landingStallDescription } from '../progress.js';

/**
 * The progress record of one in-process batch: every board write, wait report, line it says and batch record it
 * writes counts, and so does growth of its active gate log, read when asked. It holds no timer: the drive cell's
 * landing job reads lastProgressAt on its heartbeat and calls stall() once the limit passed with nothing moving.
 *
 * Why: the landing worker stopped a batch after 10 minutes without progress (#3186); moving landing in process
 * dropped that stop, so a hung child could hold landing forever (#3477).
 *
 * @param {{ now?: () => number }} [options]
 * @returns {{ moved: () => void, said: (line: string) => void, record: (batch: any) => void, lastProgressAt: () => number, stall: (limitMs?: number) => void,
 *   stalled: Promise<{ batch: any, step: string }> }}
 */
export function landingProgress({ now = Date.now, gateCeilingMs = LANDING_GATE_CEILING_MS } = {}) {
  let lastAt = now();
  let gateSince = null;
  let batch = null;
  let step = 'batch startup';
  let bytes = 0;
  let stall;
  const stalled = new Promise(resolve => { stall = resolve; });
  let limitMs;
  return {
    moved() { lastAt = now(); },
    /** Read a said line: a gate's "selected; running" opens a running gate and its "run finished" closes it. */
    said(line) {
      const text = String(line ?? '');
      if (GATE_RUNNING.test(text)) gateSince = now();
      else if (GATE_FINISHED.test(text)) gateSince = null;
      lastAt = now();
    },
    record(next) {
      if (!next?.id) return;
      batch = next;
      step = next.logPath ? `${next.state}/${String(next.logPath).split('/').pop()}` : next.state;
      lastAt = now();
    },
    lastProgressAt() {
      const size = activeLogBytes(batch);
      if (size > bytes) { bytes = size; lastAt = now(); }
      // A gate still running on a runner is progress until its ceiling: the runner says nothing until the run ends,
      // and #3489's runners-only gate was stopped at 10 minutes while it ran (9 Nov) [C7].
      if (gateSince !== null && now() - gateSince < gateCeilingMs) lastAt = now();
      return lastAt;
    },
    stall(limit) { limitMs = limit; stall({ batch, step, limitMs }); },
    stalled,
  };
}

/** How long one running landing gate counts as progress; past it the no-progress stop applies again. */
export const LANDING_GATE_CEILING_MS = 60 * 60 * 1000;

/** The line a landing gate says when its run starts, and the one it says when the run ends (landing-step-gate.js). */
const GATE_RUNNING = /^gate [^:]+: .+ selected; running$/u;
const GATE_FINISHED = /^gate [^:]+: run finished /u;

/** Bytes in the batch's active gate log, or 0 when it has none yet. */
function activeLogBytes(batch) {
  if (!batch?.logPath) return 0;
  try { return statSync(batch.logPath).size; } catch { return 0; }
}

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
 * The batch runner `land` calls for every batch: it runs runLandingBatch here, with the same options,
 * ports, write list and lease checks the worker process had, so every landing the worker did still happens.
 *
 * Why: the worker was a spawned guardian and worker pair talking over IPC; the drive cell runs landing as a job in
 * the command's own process, so writes, waits and lines go straight to the parent's handlers.
 *
 * The board and ports come from `land` itself, so the batch sees the canonical operation ports `land` checked, the
 * same twelve the worker composed, and never the command's post-land suite port, which the worker never had.
 *
 * The batch reports its progress to `progress` (landingProgress). When the drive cell's landing job calls its
 * stall() (no progress for the stall limit, the repository's landing.stall, 2 minutes when unset, #3186, #5816), the
 * batch ends: its later board calls are refused, `onStall` records the batch blocked, and the runner returns that
 * stalled result, so the landing-run job is marked failed with its lease freed and the next landing can start.
 *
 * @param {{ checkAtCommit: Function, candidateWorkerFile: string, progress?: ReturnType<typeof landingProgress>,
 *   runLandingBatch?: Function }} parts - The runner's checkAtCommit and the candidate worker file, the progress
 *   record the landing job watches, and the batch engine, injectable for tests.
 * @returns {(options: object, hooks: { board: object, landingPorts: object, write: Function, checkLease: Function,
 *   checkLeaseNow: Function, onWait?: Function, onStall?: Function, say: Function, signal?: AbortSignal }) => Promise<object>}
 */
export function inProcessLandingBatch({ checkAtCommit, candidateWorkerFile, progress = landingProgress(), runLandingBatch }) {
  return async (options, { board, landingPorts, write, checkLease, checkLeaseNow, onWait, onStall, say, signal }) => {
    const engine = runLandingBatch ?? (await import('../land.js')).runLandingBatch;
    const watch = progress;
    const stop = new AbortController();
    /** A lost lease or a stall stops the batch at its next board call, as the worker's parent refused calls after an abort. */
    const live = () => {
      if (signal?.aborted) throw signal.reason;
      if (stop.signal.aborted) throw stop.signal.reason;
    };
    const fence = () => assertWorkerFence(board, options.fence, options.root);
    const batch = withLandingEnv(() => engine({ ...options, board, checkAtCommit, candidateWorkerFile, landingPorts,
      say: line => { watch.said(line); return say(line); },
      write: async (operation, args) => {
        live();
        if (!BATCH_WRITES.has(operation)) throw new Refused('LAND_WORKER', 'the landing batch requested an unsupported operation; stop it and inspect pullboard resume');
        watch.moved();
        if (operation === 'recordLandingBatch') watch.record(args?.[0]?.batch);
        const value = await write(operation, args);
        if (operation === 'recordLandingBatch') watch.record(value);
        return value;
      },
      onWait: async state => { live(); watch.moved(); return onWait?.(state); },
      // The fence re-reads Git facts itself, as the worker's did after each parent check.
      checkLease: async () => { live(); await checkLease(); checkLeaseNow(); fence(); },
      checkLeaseNow: fence }));
    const outcome = await Promise.race([batch.then(value => ({ value })), watch.stalled.then(stalled => ({ stalled }))]);
    if (!outcome.stalled) return outcome.value;
    // The hung batch is abandoned: its next board call is refused, and nothing it does later is recorded.
    batch.catch(() => {});
    const description = landingStallDescription(outcome.stalled.batch ?? { id: 'unrecorded', state: 'starting' }, outcome.stalled.step, outcome.stalled.limitMs);
    stop.abort(new Refused('LAND_STALLED', description));
    if (typeof onStall !== 'function') throw new Refused('LAND_STALLED', `${description}; the batch is ended and the next landing can start`);
    // A stall before any batch record left nothing to block: the items never left verified, and a stalled result (not a
    // refusal) lets the lander's wake start the next batch at once instead of waiting for the next accept [C7,#5816].
    if (!outcome.stalled.batch) {
      say(`landing stopped: ${description}; items remain verified and the next batch can start`);
      return { batch: null, landed: [], conflicts: [], blocked: [], culprits: [], flakes: [], stalled: true, stallDescription: description };
    }
    return await onStall({ batch: outcome.stalled.batch, step: outcome.stalled.step, description });
  };
}
