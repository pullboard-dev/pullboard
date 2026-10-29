/** Shared SQLite generations keep transport recovery separate from cleanup and capacity policy [C7]. */
import { randomUUID } from 'node:crypto';
import { recoveryIdentity } from './runner-transport.js';

/** Extend existing queues without rewriting legacy holds or changing configured capacity. */
export function initializeRunnerRecovery(db) {
  db.exec('CREATE TABLE IF NOT EXISTS runner_transport_error(host TEXT PRIMARY KEY,at TEXT NOT NULL,diagnostic TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS runner_recovery_event(id TEXT PRIMARY KEY,host TEXT NOT NULL,at TEXT NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL)');
  const columns = new Set(db.prepare('PRAGMA table_info(runner_unavailable)').all().map(row => row.name));
  for (const [name, type] of [['failure', "TEXT NOT NULL DEFAULT ''"], ['probe_after', 'INTEGER NOT NULL DEFAULT 0'],
    ['probe_token', "TEXT NOT NULL DEFAULT ''"], ['probe_until', 'INTEGER NOT NULL DEFAULT 0'], ['probe_attempts', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE runner_unavailable ADD COLUMN ${name} ${type}`);
  }
}

/** Describe the latest explicit recovery observation, including a legacy idle probe. */
export function runnerRecoveryStatus(failure) {
  let value;
  try { value = JSON.parse(failure); } catch { value = {}; }
  if (value.latestProbe) return { ...value.latestProbe, step: value.latestProbe.step ?? 'health' };
  const pending = value?.pending ?? [value?.original?.recovery];
  if (!pending.length || !pending.every(recoveryIdentity)) return { step: 'idle proof', reason: 'missing exact request ID or completion record; waiting for pinned-worker idle and writable proof or the existing manual runner command' };
  return { step: 'health', reason: 'waiting for pinned-worker readiness and exact-job cleanup proof' };
}

/** Keep each availability transition and its audit record in the same SQLite commit, including nested callers. */
function auditedChange(db, write) {
  db.exec('SAVEPOINT runner_recovery_change');
  try {
    const result = write();
    db.exec('RELEASE runner_recovery_change');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO runner_recovery_change; RELEASE runner_recovery_change');
    throw error;
  }
}

/** Record the failed call and confirming health result together, resetting only this host's recovery generation. */
export function recordRunnerFailure(db, host, reason, diagnostic, { quarantine = true } = {}) {
  if (diagnostic) db.prepare(`INSERT INTO runner_transport_error(host,at,diagnostic) VALUES(?,?,?)
    ON CONFLICT(host) DO UPDATE SET at=excluded.at,diagnostic=excluded.diagnostic`)
    .run(host, new Date().toISOString(), JSON.stringify(diagnostic));
  if (!quarantine && reason !== 'cleanup-unverified') return;
  return auditedChange(db, () => {
  const old = db.prepare('SELECT failure FROM runner_unavailable WHERE host=?').get(host);
  let prior;
  try { prior = old ? JSON.parse(old.failure) : null; } catch { prior = null; }
  const pending = [...(old ? prior?.pending ?? [prior?.original?.recovery ?? null] : []), diagnostic?.recovery ?? null];
  const failure = { original: diagnostic ?? null, pending: pending.length <= 128 ? pending : [null] };
  db.prepare('INSERT INTO runner_recovery_event VALUES(?,?,?,?,?)').run(randomUUID(), host, new Date().toISOString(), 'unavailable', JSON.stringify({ reason, failure }));
  db.prepare(`INSERT INTO runner_unavailable(host,since,detail,failure,probe_after,probe_token,probe_until)
    VALUES(?,?,?,?,?,'',0) ON CONFLICT(host) DO UPDATE SET since=excluded.since,detail=excluded.detail,
    failure=excluded.failure,probe_after=excluded.probe_after,probe_token='',probe_until=0,probe_attempts=0`)
    .run(host, new Date().toISOString(), reason === 'cleanup-unverified' ? 'CLEANUP_UNVERIFIED'
      : reason === 'worker-unresponsive' ? 'WORKER_UNRESPONSIVE' : 'TRANSPORT_UNVERIFIED',
      JSON.stringify(failure), Date.now() + 1_000);
  });
}

/** Probe due failed generations outside transactions; only exact or explicit idle proofs restore availability. */
export async function recoverUnavailableRunners(db, runners, { probe, idleProbe, now = Date.now() } = {}) {
  if (typeof probe !== 'function') return false;
  const configured = new Map(runners.map(runner => [runner.host, runner]));
  const rows = db.prepare(`SELECT * FROM runner_unavailable WHERE probe_after<=? AND probe_until<=?
    AND NOT EXISTS(SELECT 1 FROM runner_draining WHERE host=runner_unavailable.host)`)
    .all(now, now).filter(row => configured.has(row.host));
  const results = await Promise.all(rows.map(async row => {
    const token = randomUUID();
    const claimed = db.prepare(`UPDATE runner_unavailable SET probe_token=?,probe_until=? WHERE host=? AND since=?
      AND probe_until<=? AND probe_after<=?`).run(token, now + 10_000, row.host, row.since, now, now).changes;
    if (!claimed) return false;
    let retained;
    try { retained = JSON.parse(row.failure); } catch { retained = { original: null }; }
    const pending = retained.pending ?? [retained.original?.recovery ?? null];
    let result;
    const legacy = !pending.length || !pending.every(recoveryIdentity);
    if (legacy) {
      if (typeof idleProbe === 'function') {
        try { result = await idleProbe(configured.get(row.host)); }
        catch { result = { healthy: false, step: 'idle proof', reason: 'pinned-worker idle observation unavailable' }; }
        if (result?.healthy !== true || result.idle !== true || result.writable !== true)
          result = { ...result, healthy: false, step: 'idle proof', reason: result?.reason ?? 'pinned-worker idle and writable proof missing' };
      } else {
        result = { healthy: false, step: 'idle proof', reason: 'legacy failure: missing exact request ID or completion record; use the existing runner command after inspecting the host' };
      }
    } else {
      try { result = await probe(configured.get(row.host), pending); }
      catch { result = { healthy: false, step: 'worker readiness', reason: 'health observation unavailable' }; }
    }
    if (result?.healthy === true) {
      return auditedChange(db, () => {
      const removed = db.prepare(`DELETE FROM runner_unavailable WHERE host=? AND since=? AND probe_token=?
        AND NOT EXISTS(SELECT 1 FROM runner_draining WHERE host=runner_unavailable.host)`).run(row.host, row.since, token).changes > 0;
      if (removed) db.prepare('INSERT INTO runner_recovery_event VALUES(?,?,?,?,?)')
        .run(randomUUID(), row.host, new Date().toISOString(), 'available', JSON.stringify({ priorReason: row.detail, failure: retained.original, probe: result }));
      return removed;
      });
    }
    const attempts = Math.min(16, row.probe_attempts + 1);
    const delay = ['CLEANUP_UNVERIFIED', 'WORKER_UNRESPONSIVE'].includes(row.detail)
      ? 300_000 : Math.min(60_000, 1_000 * 2 ** Math.min(6, attempts));
    db.prepare(`UPDATE runner_unavailable SET probe_token='',probe_until=0,probe_after=?,probe_attempts=?,failure=?
      WHERE host=? AND since=? AND probe_token=?`)
      .run(now + delay, attempts, JSON.stringify({ ...retained, latestProbe: result }), row.host, row.since, token);
    return false;
  }));
  return results.some(Boolean);
}
