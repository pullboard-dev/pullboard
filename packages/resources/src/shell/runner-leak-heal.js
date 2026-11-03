/** A quarantined runner with no holders gets its leaked job processes stopped and is proven idle again [C7]. */
import { randomUUID } from 'node:crypto';

/** Seconds a no-holder runner waits between heal attempts; a healed runner returns well inside a minute. */
const HEAL_RETRY_MS = 30_000;
/** The longer wait for runners that may still be doing work. */
const CLEANUP_RETRY_MS = 300_000;

/** Count controller holders for a host; null when the table cannot be read, which never counts as zero. */
export function runnerHolders(db, host) {
  try { return db.prepare('SELECT COUNT(*) AS n FROM holder WHERE runner=? OR name=?').get(host, `runner:${host}`).n; }
  catch { return null; }
}

/** How long a failed cleanup proof waits before the next try: short only when nothing holds the runner. */
export function healDelay(db, row, leakProbe) {
  return typeof leakProbe === 'function' && row.detail === 'CLEANUP_UNVERIFIED' && runnerHolders(db, row.host) === 0 ? HEAL_RETRY_MS : CLEANUP_RETRY_MS;
}

/**
 * With zero holders, stop leaked job processes and ask the idle probe again, recording a runner_recovery_event.
 * A runner with a holder, or whose holders cannot be read, is returned untouched.
 */
export async function healLeakedRunner(db, row, runner, result, { idleProbe, leakProbe }) {
  if (typeof leakProbe !== 'function' || typeof idleProbe !== 'function' || runnerHolders(db, row.host) !== 0) return result;
  let leak;
  try { leak = await leakProbe(runner); } catch { return result; }
  const stopped = Array.isArray(leak?.stopped) ? leak.stopped : [];
  if (!stopped.length) return result;
  let proof;
  try { proof = await idleProbe(runner); }
  catch { proof = { healthy: false, step: 'idle proof', reason: 'idle observation after leaked job cleanup unavailable' }; }
  if (proof?.healthy !== true || proof.idle !== true || proof.writable !== true)
    proof = { ...proof, healthy: false, step: 'idle proof', reason: proof?.reason ?? 'idle and writable proof missing after leaked job cleanup' };
  db.prepare('INSERT INTO runner_recovery_event VALUES(?,?,?,?,?)')
    .run(randomUUID(), row.host, new Date().toISOString(), 'leaked-jobs-stopped', JSON.stringify({ stopped, before: result?.reason ?? null, after: proof }));
  return proof;
}
