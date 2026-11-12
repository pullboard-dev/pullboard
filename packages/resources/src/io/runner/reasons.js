/** Explain why a queued run still waits, from the pool's own local facts and no network probe [C7,Q1,Q2]. */
import { runnerRecoveryStatus } from '../recovery.js';

/** The runner kept for timed checks, or '' when none is kept or this pool predates the reserve table. */
function keptTimingRunner(db) {
  try { return db.prepare('SELECT host FROM runner_timing_reserve WHERE singleton=1').get()?.host ?? ''; }
  catch { return ''; }
}

/** Whether a timed check waits in the gate line for a runner, which stops the kept runner lending slots. */
function timedCheckWaiting(db) {
  return Boolean(db.prepare("SELECT 1 FROM waiter WHERE name = 'gate' AND timing = 1 AND remote = 1 LIMIT 1").get());
}

/**
 * Name the kept-runner rule that admission applies on top of capacity, so a skipped runner never reads as
 * queue priority [C7,#3500]. A timed check runs only on the kept runner; an ordinary run gets the kept runner
 * only when no other runner is free and no timed check waits.
 */
function withTimingReserve(db, explained, waiter) {
  const kept = keptTimingRunner(db);
  if (!kept) return explained;
  const timedWaiting = waiter.timing !== 1 && timedCheckWaiting(db);
  const otherFree = explained.some(entry => entry.host !== kept && entry.reason === 'available');
  return explained.map(entry => {
    if (entry.reason !== 'available') return entry;
    if (waiter.timing === 1 && entry.host !== kept) return { ...entry, reason: `unavailable (timed checks run only on ${kept}, the runner kept for them)` };
    if (waiter.timing !== 1 && entry.host === kept && timedWaiting) return { ...entry, reason: 'kept for timed checks (a timed check is waiting)' };
    if (waiter.timing !== 1 && entry.host === kept && otherFree) return { ...entry, reason: 'kept for timed checks (lent only when every other runner is full)' };
    return entry;
  });
}

/** Explain each registered runner from the same local facts used by admission; no network probe. */
export function runnerWaitReasons(db, runners, waiter, unavailable) {
  return withTimingReserve(db, runners.map(runner => {
    const recorded = db.prepare('SELECT detail,failure FROM runner_unavailable WHERE host = ?').get(runner.host);
    const observed = db.prepare('SELECT gui FROM runner_gui WHERE host = ?').get(runner.host);
    const gui = observed ? observed.gui === 1 : runner.gui === true;
    const holders = db.prepare('SELECT agent, item, browser, timing FROM holder WHERE name = ?').all(`runner:${runner.host}`);
    const drain = db.prepare('SELECT token, agent, item FROM runner_timing_drain WHERE singleton=1 AND host=?').get(runner.host);
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
    return { host: runner.host, reason, slots: { total: runner.slots, free: Math.max(0, runner.slots - holders.length) },
      browser: { total: runner.browser, free: Math.max(0, runner.browser - holders.filter(holder => holder.browser === 1).length) },
      holders: holders.map(holder => ({ agent: holder.agent, item: holder.item || null, browser: holder.browser === 1, timing: holder.timing === 1 })),
      ...(drain ? { timingDrain: { own: drain.token === waiter.token, agent: drain.agent, item: drain.item || null } } : {}) };
  }), waiter);
}

/** Report the same observed capacities and holders that the local admission queue used [Q1,Q2]. */
export function runnerWaitLine(wait) {
  const needs = ['gate', ...(wait.browser ? ['browser'] : []), ...(wait.gui ? ['GUI'] : []), ...(wait.timing ? ['timing exclusivity'] : [])];
  const hosts = wait.runners.map(runner => {
    const holders = runner.holders.map(holder => `${holder.agent}${holder.item ? ` #${holder.item}` : ''}${holder.browser ? ' browser' : ''}${holder.timing ? ' exclusive' : ''}`).join(', ') || 'none';
    const drain = runner.timingDrain ? `; timing drain ${runner.timingDrain.agent}${runner.timingDrain.item ? ` #${runner.timingDrain.item}` : ''}` : '';
    return `${runner.host}: ${runner.reason === 'available' ? 'queue priority' : runner.reason}, gate ${runner.slots.free}/${runner.slots.total} free, browser ${runner.browser.free}/${runner.browser.total} free, leases ${holders}${drain}`;
  });
  return `runner wait: needs ${needs.join(' + ')}; ${hosts.join('; ') || 'no eligible registered runner'}`;
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

/** How often a gate past its runner deadline repeats an unchanged state: one heartbeat line a minute. */
export const DEADLINE_HEARTBEAT_MS = 60_000;

/**
 * The lines a gate past its runner deadline prints for one poll. The deadline state prints once when it changes, then at
 * most one heartbeat a minute naming the runner slots and the holders it waits for; the heartbeat states how many
 * unchanged polls it left out, so the output stays bounded and says what it omits [C7].
 *
 * @param {{ line?: string, at?: number, skipped?: number }} memory - What this wait printed last, updated in place.
 * @param {{ at: number, branch: string, runners: { host: string, reason: string }[] }} deadline - The overdue facts.
 * @param {Parameters<typeof runnerWaitLine>[0] | undefined} wait - The slot and holder state the gate waits on, when known.
 * @param {number} now - The poll's time in milliseconds.
 * @returns {string[]} The lines to print: none, the changed state, or one heartbeat.
 */
export function runnerDeadlineOutput(memory, deadline, wait, now) {
  const line = runnerDeadlineLine(deadline);
  if (line !== memory.line) {
    Object.assign(memory, { line, at: now, skipped: 0 });
    return [line];
  }
  memory.skipped = (memory.skipped ?? 0) + 1;
  if (now - (memory.at ?? now) < DEADLINE_HEARTBEAT_MS) return [];
  const skipped = memory.skipped;
  Object.assign(memory, { at: now, skipped: 0 });
  return [`still past the runner deadline; ${wait ? runnerWaitLine(wait) : 'no runner slot state'}; ${skipped} unchanged polls not printed`];
}
