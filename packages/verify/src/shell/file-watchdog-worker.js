/** Independent supervision still runs while a test blocks its main JavaScript thread [C7,V10]. */
import { parentPort } from 'node:worker_threads';
import { workerData } from 'node:worker_threads';
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileIdleHung } from '../core/file-watchdog-policy.js';

const tests = new Map();
let quietAt = performance.now();
let cpuAt = process.cpuUsage();
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
  cpuAt = process.cpuUsage();
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
  const quietMs = performance.now() - quietAt;
  if (quietMs < workerData.idleMs) return;
  const cpu = process.cpuUsage(cpuAt);
  if (fileIdleHung({ quietMs, cpuMicros: cpu.user + cpu.system }, workerData.idleMs)) hung(`silent and under 1% CPU for ${workerData.idleMs}ms`);
  else activity();
}, Math.max(1, Math.min(1000, Math.ceil(workerData.idleMs / 4))));
