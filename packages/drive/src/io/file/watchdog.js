/** @pullboard-module-loads packages/drive/src/io/file/watchdog/worker.js */
/**
 * Install whole-file supervision without depending on a responsive test event loop [C7,V10]. Why the header: the
 * worker starts from a URL, not an import, so package and fixture copies follow the declared load instead.
 */
import { Worker } from 'node:worker_threads';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { cpus } from 'node:os';
import { loadavg } from 'node:os';
import { fileWatchdogLimits } from '../../logic/policy.js';
import { environmentAdapter } from '../../../../env/index.js';

/** The per-file watchdog's worker module, for callers that start or inspect it without loading drive's shell. */
export const FILE_WATCHDOG_WORKER = new URL('./watchdog/worker.js', import.meta.url);

/** Observe real writes and return a lifecycle reporter for the current test-file process. */
export function installFileWatchdog(file) {
  const environment = environmentAdapter();
  const path = relative(realpathSync(process.cwd()), realpathSync(resolve(file))).replaceAll('\\', '/');
  const limits = fileWatchdogLimits(path, environment.all(), { load: loadavg()[0], cores: cpus().length });
  // The limit this file actually ran under, kept in its own output beside the results.
  if (limits.loadFactor > 1) process.stderr.write(`# run-tests: wall limit ${limits.wallMs}ms (${limits.baseWallMs}ms x ${limits.loadFactor.toFixed(2)} for machine load)\n`);
  const legacyDirectory = environment.get('PULLBOARD_LEGACY_WATCHDOG_DIR');
  if (legacyDirectory) environment.delete('PULLBOARD_LEGACY_WATCHDOG_DIR');
  const worker = new Worker(FILE_WATCHDOG_WORKER, {
    workerData: { file, ...limits, outputMarker: legacyDirectory ? join(legacyDirectory, String(process.pid)) : environment.get('PULLBOARD_TEST_WATCHDOG_OUTPUT') }, execArgv: [], env: { ...environment.all(), NODE_OPTIONS: '' },
  });
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    /** Preserve stream backpressure, encoding and callback semantics while recording output. */
    stream.write = function (...args) {
      if (args[0]?.length > 0) worker.postMessage({ type: 'output', text: typeof args[0] === 'string' ? args[0].slice(-2000) : Buffer.from(args[0]).subarray(-2000).toString() });
      return Reflect.apply(write, this, args);
    };
  }
  worker.unref();
  return (id, name, timeoutMs) => worker.postMessage({ type: 'test', id, name, timeoutMs });
}
