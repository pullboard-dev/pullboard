/** A quarantined runner with no holders gets its leaked job processes stopped and is proven idle again [C7]. */
import { randomUUID } from 'node:crypto';

/** Seconds a no-holder runner waits between heal attempts; a healed runner returns well inside a minute. */
export const HEAL_RETRY_MS = 30_000;
/** How long a heal keeps its reservation of the quarantine generation, covering the ssh stop and the idle proof. */
export const HEAL_RESERVE_MS = 60_000;
/** The longer wait for runners that may still be doing work. */
const CLEANUP_RETRY_MS = 60_000;

/** Count controller holders for a host; null when the table cannot be read, which never counts as zero. */
export function runnerHolders(db, host) {
  try { return db.prepare('SELECT COUNT(*) AS n FROM holder WHERE runner=? OR name=?').get(host, `runner:${host}`).n; }
  catch { return null; }
}

/** How long a failed cleanup proof waits before the next try: short only when nothing holds the runner. */
export function healDelay(db, row, leakProbe) {
  return typeof leakProbe === 'function' && ['CLEANUP_UNVERIFIED', 'TRANSPORT_UNVERIFIED'].includes(row.detail) ? HEAL_RETRY_MS : CLEANUP_RETRY_MS;
}

/**
 * With zero holders, stop leaked job processes and ask the idle probe again, recording a runner_recovery_event.
 * A runner with a holder, or whose holders cannot be read, is returned untouched.
 */
export async function healLeakedRunner(db, row, runner, result, { idleProbe, leakProbe, token, now = Date.now() }) {
  if (typeof leakProbe !== 'function' || typeof idleProbe !== 'function') return result;
  // Fence the whole host for this quarantine generation: registration will not clear it and admission skips every slot while it stands.
  const reserved = db.prepare('UPDATE runner_unavailable SET probe_until=?,healing=1 WHERE host=? AND since=? AND probe_token=?')
    .run(now + HEAL_RESERVE_MS, row.host, row.since, token).changes;
  if (!reserved) return result;
  let leak;
  try { leak = await leakProbe(runner); } catch { return result; }
  if (leak?.ok !== true) return result;
  const stopped = Array.isArray(leak.stopped) ? leak.stopped : [];
  // The quarantine was about one leaked job. Once the runner answers that nothing of it remains, stopped or already
  // gone, the runner is clean of that job and returns to service even while other seats' jobs run on it: demanding a
  // fully idle runner kept every runner dark under load on 6 Nov, and nothing could land [C7].
  const busy = runnerHolders(db, row.host) !== 0;
  let proof = { healthy: true, idle: !busy, writable: true, step: 'leak proof',
    reason: stopped.length ? `leaked job processes stopped: ${stopped.join(', ')}` : 'no leaked job process remains on the runner' };
  if (!busy) {
    try { proof = await idleProbe(runner); }
    catch { proof = { healthy: false, step: 'idle proof', reason: 'idle observation after leaked job cleanup unavailable' }; }
    if (proof?.healthy !== true || proof.idle !== true || proof.writable !== true)
      proof = { ...proof, healthy: false, step: 'idle proof', reason: proof?.reason ?? 'idle and writable proof missing after leaked job cleanup' };
  }
  db.prepare('INSERT INTO runner_recovery_event VALUES(?,?,?,?,?)')
    .run(randomUUID(), row.host, new Date().toISOString(), 'leaked-jobs-stopped', JSON.stringify({ stopped, busy, before: result?.reason ?? null, after: proof }));
  return proof;
}
