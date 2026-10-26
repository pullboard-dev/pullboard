/** Bounded runner admission and read-only overdue queue status [C7,Q1,Q2]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { machineHome } from './machine-home.js';
import { Refused } from './refused.js';

export const DEFAULT_RUNNER_WAIT_MS = 300_000;

/** Validate a machine's finite runner wait without allowing Node timer overflow. */
export function validateRunnerWaitMs(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Refused('BAD_MACHINE_SETTINGS', 'gate.runnerWaitMs must be a positive whole number of milliseconds, at most 2147483647; run pullboard settings gate.runnerWaitMs <n>');
  }
  return value;
}

/** Explain each registered runner from the same local facts used by admission; no network probe. */
export function runnerWaitReasons(db, runners, waiter, unavailable) {
  return runners.map(runner => {
    const recorded = db.prepare('SELECT detail FROM runner_unavailable WHERE host = ?').get(runner.host);
    const observed = db.prepare('SELECT gui FROM runner_gui WHERE host = ?').get(runner.host);
    const gui = observed ? observed.gui === 1 : runner.gui === true;
    const holders = db.prepare('SELECT browser, timing FROM holder WHERE name = ?').all(`runner:${runner.host}`);
    let reason = 'available';
    if (unavailable.has(runner.host) && recorded?.detail === 'TRANSPORT_LOST') reason = 'unreachable (transport lost)';
    else if (unavailable.has(runner.host)) reason = 'unavailable (cleanup or draining)';
    else if (waiter.gui === 1 && !gui) reason = 'unavailable (GUI session required)';
    else if (waiter.browser === 1 && runner.browser < 1) reason = 'unavailable (browser capacity required)';
    else if (holders.length >= runner.slots || holders.some(holder => holder.timing === 1)
      || waiter.timing === 1 && holders.length > 0
      || waiter.browser === 1 && holders.filter(holder => holder.browser === 1).length >= runner.browser) reason = 'busy';
    return { host: runner.host, reason };
  });
}

/** Name the local admission branch without changing queue order or creating capacity. */
export function localWaitBranch({ capacity, browserCapacity, runnerOnly, browser, timing, memoryHeld, holders }) {
  if (runnerOnly) return 'runner-only work has no local fallback';
  if (capacity === 0 || browser && browserCapacity === 0) return 'no local capacity';
  if (memoryHeld) return 'local memory hold';
  if (holders.some(holder => holder.timing) || timing && holders.length) return 'local timing exclusivity';
  if (browser && holders.filter(holder => holder.browser).length >= browserCapacity) return 'local browser slots busy';
  if (holders.filter(holder => holder.slot !== 'short').length >= capacity) return 'local gate slots busy';
  return 'local queue priority';
}

/** Format the same overdue facts for progress, resources, and status. */
export function runnerDeadlineLine(wait) {
  return `runner wait deadline ${new Date(wait.at).toISOString()} passed; ${wait.branch}; ${wait.runners.map(runner => `${runner.host}: ${runner.reason}`).join('; ') || 'no registered runner'}`;
}

/** Read current overdue runs without creating or migrating the resource pool. */
export function runnerDeadlineRuns() {
  const file = join(machineHome(), 'resources.sqlite');
  if (!existsSync(file)) return [];
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (!db.prepare('PRAGMA table_info(waiter)').all().some(column => column.name === 'runner_deadline')) return [];
    return db.prepare("SELECT agent, repo, item, kind, since, runner_deadline AS at, runner_wait_branch AS branch, runner_wait_reasons AS reasons FROM waiter WHERE name='gate' AND runner_deadline > 0 AND runner_deadline <= ? AND heartbeat >= ? ORDER BY ticket")
      .all(Date.now(), Date.now() - 20_000).map(({ reasons, ...run }) => ({ ...run, runners: JSON.parse(reasons) }));
  } catch (error) {
    if (['EACCES', 'EPERM', 'SQLITE_BUSY', 'SQLITE_CANTOPEN'].includes(error.code)
      || error.code === 'ERR_SQLITE_ERROR' && [5, 14].includes(error.errcode & 0xff)) return null;
    throw error;
  } finally { db?.close(); }
}
