/** Normalize execution facts without inventing missing runtime identities or test counts [C7,H16]. */
import {
  testRuntimeEnvironment,
  testRuntimeRows,
} from './execution-environment.js';

/** A bounded identity from the executor, never a command or an agent's narrative. */
function identity(value, limit = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\r\n\0]/u.test(value);
}

/** Validate the native facts attached to a version-two gate receipt. */
export function proofFields(value) {
  if (!value || !Number.isSafeInteger(value.item) || value.item < 1
    || value.frozenDigest !== null && !/^[a-f0-9]{64}$/u.test(value.frozenDigest ?? '')
    || !identity(value.seat, 256) || value.runner !== null && !identity(value.runner)
    || value.exitCode !== null && !Number.isSafeInteger(value.exitCode)
    || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || typeof value.sourceClean !== 'boolean') return null;
  const environment = value.environment;
  if (environment !== null && (!environment || !identity(environment.node, 80)
    || !identity(environment.platform, 80) || !identity(environment.arch, 80))) return null;
  const hasTestRuntimes = Object.hasOwn(value, 'testRuntimes');
  const testRuntimes = hasTestRuntimes ? testRuntimeRows(value.testRuntimes) : null;
  if (hasTestRuntimes && value.testRuntimes !== null && testRuntimes === null) return null;
  const actualEnvironment = hasTestRuntimes ? testRuntimeEnvironment(testRuntimes) : environment;
  const names = ['passed', 'failed', 'skipped'];
  if (!value.counts || !names.every(name => value.counts[name] === null
    || Number.isSafeInteger(value.counts[name]) && value.counts[name] >= 0)) return null;
  return { item: value.item, frozenDigest: value.frozenDigest,
    environment: actualEnvironment === null ? null : { node: actualEnvironment.node, platform: actualEnvironment.platform, arch: actualEnvironment.arch },
    seat: value.seat, runner: value.runner, exitCode: value.exitCode,
    counts: Object.fromEntries(names.map(name => [name, value.counts[name]])), durationMs: value.durationMs, sourceClean: value.sourceClean,
    ...(hasTestRuntimes ? { testRuntimes } : {}) };
}

/** Read explicit TAP or Node reporter totals; absent counters stay unknown rather than becoming zero. */
export function proofCounts(lines) {
  const names = { pass: 'passed', fail: 'failed', skipped: 'skipped' };
  let pending = {};
  let totals = null;
  for (const line of typeof lines === 'string' ? lines.split(/\r?\n/u) : lines) {
    const match = /^(?:#|ℹ)\s+(pass|fail|skipped)\s+(\d+)$/u.exec(line);
    if (!match) continue;
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count)) return { passed: null, failed: null, skipped: null };
    pending[names[match[1]]] = count;
    if (Object.keys(pending).length === 3) {
      totals ??= { passed: 0, failed: 0, skipped: 0 };
      for (const name of Object.values(names)) totals[name] += pending[name];
      if (!Object.values(totals).every(Number.isSafeInteger)) return { passed: null, failed: null, skipped: null };
      pending = {};
    }
  }
  return Object.keys(pending).length ? { passed: null, failed: null, skipped: null }
    : totals ?? { passed: null, failed: null, skipped: null };
}
