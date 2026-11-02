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
let quietAt = performance.now();
let tree = processTreeCpu(process.pid);
let treeMicros = 0;
let outputStamp = 0;
let killed = false;

/** Signal only this worker's own process; the existing runner custody drains its descendants. */
function hung(reason) {
  if (killed) return;
  killed = true;
  const name = tests.size ? [...tests.values()].join('; ') : '<file setup or cleanup>';
  writeSync(2, `run-tests: HUNG file ${JSON.stringify(workerData.file)} test ${JSON.stringify(name)}: ${reason}\n`);
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
    if (message.name === null) tests.delete(message.id);
    else tests.set(message.id, message.name);
  }
});
setTimeout(() => hung(`whole-file wall limit ${workerData.wallMs}ms`), workerData.wallMs);
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
