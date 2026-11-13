/** One runner is kept for timed checks, so a timed check never drains a runner ordinary runs are using [C7]. */

import { Refused } from '../../../../kernel/light.js';

/** A runner-reported load this recent counts as a measurement of its headroom. */
const RESERVE_READING_FRESH_MS = 10 * 60_000;

/** The hosts a waiter's explicit executor restriction names, or null when it names none. */
function restrictedHosts(waiter) {
  const restriction = waiter.requiredExecutor ? JSON.parse(waiter.requiredExecutor) : null;
  if (restriction?.kind !== 'ssh') return null;
  return restriction.hosts ?? [restriction.host];
}

/**
 * A runner's measured headroom in cores: its cores less its 1-minute load, from a recent runner-reported
 * reading. A runner without a usable reading has no measured headroom.
 */
function measuredHeadroom(runner, now) {
  const load = runner.cpuLoad?.average?.[0];
  const age = now - Date.parse(runner.cpuLoad?.at);
  if (!Number.isSafeInteger(runner.cores) || runner.cores < 1 || !Number.isFinite(load) || load < 0) return null;
  return Number.isFinite(age) && age >= 0 && age <= RESERVE_READING_FRESH_MS ? runner.cores - load : null;
}

/**
 * Choose the runner kept for timed checks, or null when none is kept and the earlier drain rule applies.
 * `setting` comes from the machine's gate.timingRunner: 'auto' (the gate's default) picks one by measured headroom
 * (most headroom, then most cores, then registration order), a host keeps that registered runner, and false keeps
 * none. A caller that passes no setting keeps none, so direct resource callers keep the drain rule. The pick
 * is stored, so it holds steady while load moves, and is picked again only when that runner leaves the pool
 * or becomes unavailable. Why at least two runners: with one, keeping it would leave ordinary runs no runner.
 * `requester` is the waiter asking now; a runner restriction it cannot meet under the kept runner is refused.
 */
export function reservedTimingRunner(db, runners, unavailable, setting, now, requester) {
  const host = keptRunner(db, runners, unavailable, setting, now);
  refuseTimingRestriction(host, requester);
  return host;
}

/** Choose and store the kept runner without judging any one request; see reservedTimingRunner. */
function keptRunner(db, runners, unavailable, setting, now) {
  db.exec('CREATE TABLE IF NOT EXISTS runner_timing_reserve (singleton INTEGER PRIMARY KEY CHECK(singleton=1), host TEXT NOT NULL, chosen_at TEXT NOT NULL, reason TEXT NOT NULL)');
  const saved = db.prepare('SELECT host FROM runner_timing_reserve WHERE singleton=1').get()?.host;
  /** Store the kept runner; a kept runner replaces any drain, which only an unkept pool needs. */
  const keep = (host, reason) => {
    if (host !== saved) db.prepare('INSERT INTO runner_timing_reserve VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET host=excluded.host, chosen_at=excluded.chosen_at, reason=excluded.reason')
      .run(host, new Date(now).toISOString(), reason);
    db.prepare('DELETE FROM runner_timing_drain WHERE singleton=1').run();
    return host;
  };
  if ((setting !== 'auto' && typeof setting !== 'string') || runners.length < 2) {
    db.prepare('DELETE FROM runner_timing_reserve WHERE singleton=1').run();
    return null;
  }
  if (setting !== 'auto') return runners.some(runner => runner.host === setting) ? keep(setting, 'configured') : null;
  if (saved && runners.some(runner => runner.host === saved) && !unavailable.has(saved)) return keep(saved, 'kept');
  const candidates = runners.map((runner, order) => ({ runner, order, headroom: measuredHeadroom(runner, now) }))
    .filter(row => !unavailable.has(row.runner.host));
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.headroom ?? -Infinity) - (a.headroom ?? -Infinity)
    || (b.runner.cores ?? 0) - (a.runner.cores ?? 0) || a.order - b.order);
  const best = candidates[0];
  return keep(best.runner.host, best.headroom === null ? 'most cores' : `most measured headroom (${best.headroom.toFixed(1)} cores)`);
}

/**
 * Refuse a request whose own runner restriction cannot meet the kept runner: a timed check restricted away from it,
 * or an ordinary run restricted to it alone. Why refuse: either would otherwise wait forever for a runner it can
 * never have, and quietly widening the restriction would run work where it was told not to.
 */
function refuseTimingRestriction(reserved, waiter) {
  if (!reserved || !waiter || waiter.remote !== 1) return;
  const restriction = waiter.requiredExecutor ? JSON.parse(waiter.requiredExecutor) : null;
  if (waiter.timing === 1 && restriction?.kind === 'local') {
    throw new Refused('TIMING_RUNNER_RESTRICTION', `timed checks run only on ${reserved}; drop the local executor restriction or turn off gate.timingRunner`);
  }
  const hosts = restrictedHosts(waiter);
  if (hosts === null) return;
  if (waiter.timing === 1 && !hosts.includes(reserved)) {
    throw new Refused('TIMING_RUNNER_RESTRICTION', `timed checks run only on ${reserved}, the runner kept for them, but this request names ${hosts.join(', ')}; drop the host restriction, or set gate.timingRunner to one of those hosts`);
  }
  if (waiter.timing !== 1 && hosts.every(host => host === reserved)) {
    throw new Refused('TIMING_RUNNER_RESTRICTION', `${reserved} is kept for timed checks and takes no ordinary run; name another runner, or set gate.timingRunner to another host or false`);
  }
}

/**
 * Whether a waiter may use a runner while one is kept for timed checks: a timed check only it, an ordinary run any other.
 * With the gate line as `lendingTo`, it asks instead whether the kept runner lends this ordinary run a slot.
 */
export function timingReserveAllows(reserved, waiter, runner, lendingTo = null) {
  if (lendingTo) return runner.host === reserved && timingReserveLends(reserved, waiter, lendingTo);
  if (!reserved) return true;
  return waiter.timing === 1 ? runner.host === reserved : runner.host !== reserved;
}

/**
 * Whether the kept runner may lend a free slot to this ordinary run once no other runner fits it. Why: with no timed
 * check waiting, a kept runner that refuses ordinary work sits idle while the queue waits (7 Nov: the 12-core big runner
 * was kept for most cores and took no run for hours). A waiting timed check stops the lending, so the kept runner
 * drains to it as its lent runs finish.
 */
export function timingReserveLends(reserved, waiter, waiters) {
  return Boolean(reserved) && waiter.timing !== 1 && !waiters.some(other => other.timing === 1 && other.remote === 1);
}
