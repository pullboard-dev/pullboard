/** Install whole-file supervision without depending on a responsive test event loop [C7,V10]. */
import { Worker } from 'node:worker_threads';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileWatchdogLimits } from '../core/file-watchdog-policy.js';

/** Observe real writes and return a lifecycle reporter for the current test-file process. */
export function installFileWatchdog(file) {
  const path = relative(realpathSync(process.cwd()), realpathSync(resolve(file))).replaceAll('\\', '/');
  const limits = fileWatchdogLimits(path);
  const worker = new Worker(new URL('./file-watchdog-worker.js', import.meta.url), {
    workerData: { file, ...limits, outputMarker: process.env.PULLBOARD_TEST_WATCHDOG_OUTPUT ?? (process.env.PULLBOARD_LEGACY_WATCHDOG_DIR ? join(process.env.PULLBOARD_LEGACY_WATCHDOG_DIR, String(process.pid)) : undefined) }, execArgv: [], env: { ...process.env, NODE_OPTIONS: '' },
  });
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    /** Preserve stream backpressure, encoding and callback semantics while recording output. */
    stream.write = function (...args) {
      if (args[0]?.length > 0) worker.postMessage({ type: 'output' });
      return Reflect.apply(write, this, args);
    };
  }
  worker.unref();
  return (id, name) => worker.postMessage({ type: 'test', id, name });
}
