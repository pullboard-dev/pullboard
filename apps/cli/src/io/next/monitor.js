/** Observe native next phases independently of its synchronous board work, without any board authority [C7]. */
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/** Use the same monotonic process clock in both threads, without depending on wall-clock corrections. */
function monotonicMs() { return Number(process.hrtime.bigint() / 1_000_000n); }

/** Write one phase line straight to the inherited descriptor; Worker stdio forwarding would itself block on the parent. */
function phaseLine(fd, phase, item, started) {
  const text = `next phase ${phase}; item ${item === null ? 'not yet selected' : '#' + item}; ${Math.max(0, monotonicMs() - started)} ms\n`;
  fs.write(fd, text);
}

/** Own only a timer and the inherited diagnostic descriptor; no native role, board, claim or process-killing capability exists here. */
function observePhases() {
  const state = new Int32Array(workerData.state);
  let timer = null;
  parentPort.on('message', message => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (message.kind !== 'phase') return;
    const { generation, phase, item, started } = message;
    /** Recheck the monotonic threshold because a timer may wake just before its requested millisecond. */
    function report() {
      if (Atomics.load(state, 0) !== generation) return;
      const remaining = workerData.phaseMs - (monotonicMs() - started);
      if (remaining > 0) { timer = setTimeout(report, remaining); return; }
      if (Atomics.compareExchange(state, 0, generation, -generation) !== generation) return;
      phaseLine(workerData.fd, phase, item, started);
    }
    timer = setTimeout(report, Math.max(0, workerData.phaseMs - (monotonicMs() - started)));
  });
}

if (!isMainThread && workerData?.kind === 'next-progress') observePhases();

/** A file-backed Worker cannot inherit the parent eval input type; retain every other argument verbatim. */
function monitorExecArgv() {
  const args = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const value = process.execArgv[index];
    if (value === '--input-type') { index++; continue; }
    if (!value.startsWith('--input-type=')) args.push(value);
  }
  return args;
}

/**
 * Start one diagnostic worker before native routing and return at once; the worker reads the phases queued while it boots.
 * Why: awaiting its readiness, and its termination at close, left a cold next idle on its own thread's start-up [C7,#8574].
 */
export function startNextProgressMonitor(io, { phaseMs = 10_000 } = {}) {
  // Only the actual CLI stream permits descriptor writes; an adapter can expose fd 2 while capturing write().
  if (io.stderr !== process.stderr) return null;
  const fd = io.stderr.fd;
  if (!Number.isSafeInteger(fd) || fd < 0) return null;
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT), state = new Int32Array(shared);
  const worker = new Worker(new URL('./monitor.js', import.meta.url),
    { execArgv: monitorExecArgv(), workerData: { kind: 'next-progress', state: shared, fd, phaseMs } });
  let failure = null, generation = 0, current = null;
  worker.on('error', error => { failure = error; });
  // A phase message posted before the worker listens waits in its port; each carries its own start, so no threshold moves.
  worker.unref();
  /** Publish the real phase before its synchronous work; a new generation invalidates every older pending timer. */
  function enter(phase, item) {
    if (failure) throw failure;
    generation++;
    Atomics.store(state, 0, generation);
    current = { kind: 'phase', generation, phase, item, started: monotonicMs() };
    worker.postMessage(current);
  }
  /** Share the exactly-once flag with the independent timer when a phase completes near its reporting threshold. */
  function warn() {
    if (current && Atomics.compareExchange(state, 0, current.generation, -current.generation) === current.generation) {
      phaseLine(fd, current.phase, current.item, current.started);
    }
  }
  /** Invalidate a finished or deliberately idle phase without cancelling any native operation. */
  function stop() {
    Atomics.store(state, 0, ++generation);
    current = null;
    worker.postMessage({ kind: 'stop' });
  }
  /** Stop this owned diagnostic thread without waiting for it; the stopped generation already silences any pending line. */
  async function close() { stop(); worker.terminate().catch(() => { /* the thread has already ended */ }); }
  return { enter, warn, stop, close };
}
