/** Where a queued gate waiter may be placed now, and whether it is still polling for a slot [C7,#3692]. */

/**
 * How recently an earlier gate waiter must have polled admission to hold a free slot ahead of a later one [C7,#3692].
 * Why: a waiter whose process is not polling cannot take the slot now; its renewal beat keeps its heartbeat fresh
 * for up to an hour, so on 7 Nov its unused place held free runner slots from every later gate.
 */
export const ADMISSION_POLL_FRESH_MS = 10_000;

/** Return the durable runner allowlist; legacy restrictions continue to name only their preferred host. */
export function requiredRunnerHosts(waiter) {
  if (!waiter?.requiredExecutor) return null;
  const restriction = typeof waiter.requiredExecutor === 'string' ? JSON.parse(waiter.requiredExecutor) : waiter.requiredExecutor;
  if (restriction?.kind !== 'ssh') return null;
  return restriction.hosts ?? [restriction.host];
}
/** A preferred-host restriction narrows only this waiter, never the machine-wide runner registry. */
export function runnerAllowed(waiter, runner) { const hosts = requiredRunnerHosts(waiter); return hosts === null || hosts.includes(runner.host); }

/**
 * Whether admission may place this waiter on the runner now: its allowed hosts, or any registered runner once every
 * allowed host is out of service [C7,#3692]. Why: a pin names where the run was meant to go; when every pinned host
 * failed readiness or is quarantined, waiting on it held the run (and its place) until the deadline while other
 * runners had free slots. A pin to a busy but healthy host still waits for that host.
 */
export function runnerAllowedNow(waiter, runner, runners, unavailable) {
  if (runnerAllowed(waiter, runner)) return true;
  const hosts = requiredRunnerHosts(waiter);
  return hosts !== null && runners.some(row => hosts.includes(row.host)) && runners.every(row => !hosts.includes(row.host) || unavailable.has(row.host));
}

/** Whether a queued waiter polled admission recently; a row from an older pullboard (never stamped) counts as polling. */
export function pollingNow(waiter, now) {
  return !(waiter.polled > 0) || now - waiter.polled < ADMISSION_POLL_FRESH_MS;
}
