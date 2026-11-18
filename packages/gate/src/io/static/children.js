import { spawn } from 'node:child_process';
import { Refused } from '../../../../kernel/index.js';

/**
 * Run one child process to the end and answer what spawnSync would: status, stdout, stderr, and an ETIMEDOUT error when the
 * deadline killed it. Why: the registry's async entry overlaps its children, and its checks read the same result shape [C7].
 *
 * @param {{args: string[], options: {cwd: string, timeout?: number, killSignal?: string}}} spec - What to run.
 * @returns {Promise<{status: number|null, stdout: string, stderr: string, error?: {code: string}}>}
 */
export function runChild({ args, options }) {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    let timedOut = false;
    const timer = options.timeout ? setTimeout(() => { timedOut = true; child.kill(options.killSignal ?? 'SIGTERM'); }, options.timeout) : null;
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    const finish = (status, error) => {
      clearTimeout(timer);
      resolveRun({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), ...(timedOut ? { error: { code: 'ETIMEDOUT' } } : error ? { error } : {}) });
    };
    child.on('error', error => finish(null, error));
    child.on('close', status => finish(status));
  });
}

/**
 * Check the cap landing.staticParallelMax names.
 *
 * @param {unknown} max - The setting's value.
 * @returns {number} The cap, a whole number of at least 1.
 */
export function parallelCap(max) {
  if (!Number.isSafeInteger(max) || max < 1) throw new Refused('BAD_SETTINGS', 'landing.staticParallelMax is a whole number of at least 1; unset it to run the static checks one at a time');
  return max;
}

/**
 * Run the specs with at most `max` children alive at once and answer their results in the specs' order.
 *
 * @param {Array<object>} specs - Child specs for runChild.
 * @param {number} max - Most children in flight.
 * @returns {Promise<Array<object>>} The results, in spec order.
 */
export async function runChildren(specs, max) {
  const cap = parallelCap(max);
  const results = new Array(specs.length);
  let next = 0;
  const lane = async () => { while (next < specs.length) { const at = next++; results[at] = await runChild(specs[at]); } };
  await Promise.all(Array.from({ length: Math.min(cap, specs.length) }, lane));
  return results;
}
