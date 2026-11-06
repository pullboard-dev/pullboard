/** Independent supervision still runs while a test blocks its main JavaScript thread [C7,V10]. */
import { parentPort } from 'node:worker_threads';
import { workerData } from 'node:worker_threads';
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileIdleHung } from '../core/file-watchdog-policy.js';
import { processTreeCpu } from './file-watchdog-tree.js';
import { treeCpuDelta } from './file-watchdog-tree.js';
import { statSync } from 'node:fs';

const tests = new Map();
const startedAt = new Map();
const deadlines = new Map();
let quietAt = performance.now();
let tree = processTreeCpu(process.pid);
let treeMicros = 0;
let outputStamp = 0;
let killed = false;
// Finished cases and the last case start/finish, so the wall can tell a slow file that still progresses from a stuck one.
const finished = [];
let lastFinishAt = null;

/** The durations of every finished case, so a later timeout still identifies all completed work. */
function finishedSummary() {
  return JSON.stringify(finished);
}

/** Signal only this worker's own process; the existing runner custody drains its descendants. */
function hung(reason, wall = false) {
  if (killed) return;
  killed = true;
  const name = tests.size ? [...tests.values()].join('; ') : '<file setup or cleanup>';
  if (wall) {
    // Past even the load-scaled wall: a TIMEOUT that names the slowest case still running, not a plain failure.
    const [slowest] = [...startedAt].sort((a, b) => a[1] - b[1]);
    const running = slowest ? `${tests.get(slowest[0])} (running ${Math.round(performance.now() - slowest[1])}ms)` : name;
    writeSync(2, `run-tests: TIMEOUT file ${JSON.stringify(workerData.file)} slowest running case ${JSON.stringify(running)}: ${reason}; finished cases ${finishedSummary()}\n`);
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  writeSync(2, `run-tests: HUNG file ${JSON.stringify(workerData.file)} test ${JSON.stringify(name)}: ${reason}; finished cases ${finishedSummary()}\n`);
  process.kill(process.pid, 'SIGKILL');
}

/** Output begins a fresh quiet/CPU window; a lifecycle name alone is not output. */
function activity() {
  quietAt = performance.now();
  treeMicros = 0;
}

parentPort.on('message', message => {
  if (message.type === 'output') activity();
  if (message.type === 'test') {
    if (message.name === null) {
      lastFinishAt = performance.now();
      if (startedAt.has(message.id)) finished.push({ name: tests.get(message.id), ms: Math.round(lastFinishAt - startedAt.get(message.id)) });
      tests.delete(message.id); startedAt.delete(message.id); deadlines.delete(message.id);
    }
    else {
      const at = performance.now();
      tests.set(message.id, message.name); startedAt.set(message.id, at);
      if (Number.isSafeInteger(message.timeoutMs) && message.timeoutMs > 0) deadlines.set(message.id, at + message.timeoutMs);
    }
  }
});
/**
 * The wall bounds a stuck file, not a slow one. Past the wall a file keeps running while cases keep finishing
 * (each already bounded by its own per-case timeout). An active case also keeps its real enforced budget,
 * even when it is the first case; unknown budgets and setup or cleanup retain the existing wall guard.
 */
function wallCheck() {
  const now = performance.now();
  const sinceFinish = lastFinishAt === null ? Infinity : now - lastFinishAt;
  const withinCaseBudget = tests.size > 0 && [...tests.keys()].every(id => now < deadlines.get(id));
  if (!withinCaseBudget && sinceFinish > workerData.idleMs) hung(`whole-file wall limit ${workerData.wallMs}ms with no finished case for ${workerData.idleMs}ms`, true);
  else setTimeout(wallCheck, 250);
}
setTimeout(wallCheck, workerData.wallMs);
setInterval(() => {
  const beforeSample = process.cpuUsage();
  const current = processTreeCpu(process.pid);
  const sampling = process.cpuUsage(beforeSample);
  if (!current || !tree) { tree = current; activity(); return; }
  treeMicros += Math.max(0, treeCpuDelta(tree, current) - sampling.user - sampling.system);
  tree = current;
  if (workerData.outputMarker) {
    try {
      const stamp = statSync(workerData.outputMarker).mtimeMs;
      if (stamp !== outputStamp) { outputStamp = stamp; activity(); }
    } catch { /* No forwarded descendant output yet. */ }
  }
  const quietMs = performance.now() - quietAt;
  if (fileIdleHung({ quietMs, cpuMicros: treeMicros }, workerData.idleMs)) hung(`silent and under 1% CPU for ${workerData.idleMs}ms`);
  else if (quietMs >= workerData.idleMs) activity();
}, Math.max(250, Math.min(1000, Math.ceil(workerData.idleMs / 4))));
