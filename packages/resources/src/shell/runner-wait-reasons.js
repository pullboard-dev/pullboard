/** Explain why a queued run still waits, from the pool's own local facts and no network probe [C7,Q1,Q2]. */
import { runnerRecoveryStatus } from './resource-recovery.js';

/** Explain each registered runner from the same local facts used by admission; no network probe. */
export function runnerWaitReasons(db, runners, waiter, unavailable) {
  return runners.map(runner => {
    const recorded = db.prepare('SELECT detail,failure FROM runner_unavailable WHERE host = ?').get(runner.host);
    const observed = db.prepare('SELECT gui FROM runner_gui WHERE host = ?').get(runner.host);
    const gui = observed ? observed.gui === 1 : runner.gui === true;
    const holders = db.prepare('SELECT browser, timing FROM holder WHERE name = ?').all(`runner:${runner.host}`);
    let reason = 'available';
    if (unavailable.has(runner.host) && ['TRANSPORT_LOST', 'TRANSPORT_UNVERIFIED'].includes(recorded?.detail)) reason = 'unreachable (transport lost)';
    else if (unavailable.has(runner.host) && recorded?.detail === 'WORKER_UNRESPONSIVE') reason = 'unreachable (worker did not become ready)';
    else if (unavailable.has(runner.host)) reason = 'unavailable (cleanup or draining)';
    else if (waiter.gui === 1 && !gui) reason = 'unavailable (GUI session required)';
    else if (waiter.browser === 1 && runner.browser < 1) reason = 'unavailable (browser capacity required)';
    else if (holders.length >= runner.slots || holders.some(holder => holder.timing === 1)
      || waiter.timing === 1 && holders.length > 0
      || waiter.browser === 1 && holders.filter(holder => holder.browser === 1).length >= runner.browser) reason = 'busy';
    if (unavailable.has(runner.host) && recorded) {
      const probe = runnerRecoveryStatus(recorded.failure);
      reason += `; ${probe.step}: ${probe.reason}`;
    }
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
