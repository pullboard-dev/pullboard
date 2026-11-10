/** Lightweight runner concurrency policy shared with full gates [C7]. */
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { Refused } from '../../../../kernel/index.js';

/** Detect the performance-core budget on Apple Silicon, or the runtime's usable CPU budget elsewhere. */
export function performanceCores() {
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu'], { encoding: 'utf8' });
    const count = Number(result.stdout?.trim());
    if (result.status === 0 && Number.isSafeInteger(count) && count > 0) return count;
  }
  return Math.max(1, availableParallelism());
}

/** One policy for native file concurrency and the separate per-run browser-file limit. */
export function testConcurrency(root, cores = performanceCores()) {
  const file = join(root, 'pullboard.json');
  let config = {};
  if (existsSync(file)) {
    try { config = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Refused('BAD_CONFIG', 'pullboard.json must be valid JSON before running tests'); }
  }
  const setting = config.testConcurrency ?? {};
  if (!setting || typeof setting !== 'object' || Array.isArray(setting)) {
    throw new Refused('BAD_CONFIG', 'testConcurrency must be an object with positive integer files and browser fields');
  }
  const files = setting.files ?? cores;
  const browser = setting.browser ?? 2;
  if (!Number.isSafeInteger(files) || files < 1 || !Number.isSafeInteger(browser) || browser < 1 || browser > 2) {
    throw new Refused('BAD_CONFIG', 'testConcurrency.files must be positive; testConcurrency.browser must be 1 or 2');
  }
  return { files, browser: Math.min(files, browser) };
}

/**
 * How many shards the landing gate's test files split into: `landingShards` in pullboard.json,
 * 1 when absent, which keeps today's single run.
 *
 * @param {string} root
 * @returns {number}
 */
export function landingShardCount(root) {
  const file = join(root, 'pullboard.json');
  if (!existsSync(file)) return 1;
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Refused('BAD_CONFIG', 'pullboard.json must be valid JSON before running tests'); }
  const count = config?.landingShards ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) {
    throw new Refused('BAD_CONFIG', 'landingShards must be a whole number from 1 to 64; set it in pullboard.json, or remove it for one landing run');
  }
  return count;
}

