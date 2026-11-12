/** Independent supervision still runs while a test blocks its main JavaScript thread [C7,V10]. */
import { parentPort } from 'node:worker_threads';
import { workerData } from 'node:worker_threads';
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileIdleHung } from '../../../logic/policy.js';
import { processTreeCpu } from './tree.js';
import { treeCpuDelta } from './tree.js';
import { processTreeDescendants } from './tree.js';
import { statSync } from 'node:fs';

const tests = new Map();
const startedAt = new Map();
const deadlines = new Map();
let quietAt = performance.now();
let tree = null;
void processTreeCpu(process.pid).then(sample => { if (tree === null) tree = sample; });
let sampling = false;
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

/**
 * Stop the file's whole tree, descendants first, then the worker itself, so no grandchild keeps the output pipe open.
 * Why: the run resolves on the worker's exit; a survivor holding the pipe would stall it far past the cap.
 */
async function killTree() {
  try { for (const pid of await processTreeDescendants(process.pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } } }
  catch { /* A failed census still ends the worker below. */ }
  process.kill(process.pid, 'SIGKILL');
}

/** Report the hang or wall timeout, then stop the file's tree; a bounded stop never waits on the census. */
function hung(reason, wall = false) {
  if (killed) return;
  killed = true;
  const name = tests.size ? [...tests.values()].join('; ') : '<file setup or cleanup>';
  if (wall) {
    // Past even the load-scaled wall: a TIMEOUT that names the slowest case still running, not a plain failure.
    const [slowest] = [...startedAt].sort((a, b) => a[1] - b[1]);
    const running = slowest ? `${tests.get(slowest[0])} (running ${Math.round(performance.now() - slowest[1])}ms)` : name;
    writeSync(2, `run-tests: TIMEOUT file ${JSON.stringify(workerData.file)} slowest running case ${JSON.stringify(running)}: ${reason}; finished cases ${finishedSummary()}\n`);
    void killTree();
    return;
  }
  writeSync(2, `run-tests: HUNG file ${JSON.stringify(workerData.file)} test ${JSON.stringify(name)}: ${reason}; finished cases ${finishedSummary()}\n`);
  void killTree();
}

/** Keep the last few output lines so a budget timeout can show where the file stopped. */
const lastLines = [];
function remember(text) {
  for (const line of String(text).split(/\r?\n/u)) if (line.trim()) lastLines.push(line.slice(0, 300));
  if (lastLines.length > 10) lastLines.splice(0, lastLines.length - 10);
}

/** Past the per-file budget the file dies whatever it is doing, so a hung slot frees at the policy time, not the runner ceiling. */
function overBudget() {
  if (killed) return;
  killed = true;
  const running = [...tests.values()].join('; ') || '<file setup or cleanup>';
  writeSync(2, `run-tests: TIMEOUT file ${JSON.stringify(workerData.file)} exceeded the per-file budget ${workerData.budgetMs}ms; running ${JSON.stringify(running)}; finished cases ${finishedSummary()}; last output: ${JSON.stringify(lastLines)}\n`);
  void killTree();
}
if (workerData.budgetMs) setTimeout(overBudget, workerData.budgetMs);

/** Output begins a fresh quiet/CPU window; a lifecycle name alone is not output. */
function activity() {
  quietAt = performance.now();
  treeMicros = 0;
}

parentPort.on('message', message => {
  if (message.type === 'output') { activity(); if (message.text) remember(message.text); }
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
setInterval(async () => {
  // One census at a time: a slow ps never stacks samples, and the next tick measures from the last finished one.
  if (sampling) return;
  sampling = true;
  const beforeSample = process.cpuUsage();
  const current = await processTreeCpu(process.pid).finally(() => { sampling = false; });
  const spent = process.cpuUsage(beforeSample);
  if (!current || !tree) { tree = current; activity(); return; }
  treeMicros += Math.max(0, treeCpuDelta(tree, current) - spent.user - spent.system);
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
