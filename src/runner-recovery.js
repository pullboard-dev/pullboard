/** Shared SQLite generations keep transport recovery separate from cleanup and capacity policy [C7]. */
import { randomUUID } from 'node:crypto';
import { probeRunnerTransport } from './runner-transport.js';

/** Extend existing machine queues without changing legacy availability rows or configured capacity. */
export function initializeRunnerRecovery(db) {
  db.exec('CREATE TABLE IF NOT EXISTS runner_transport_error(host TEXT PRIMARY KEY,at TEXT NOT NULL,diagnostic TEXT NOT NULL)');
  const columns = new Set(db.prepare('PRAGMA table_info(runner_unavailable)').all().map(row => row.name));
  for (const [name, type] of [['failure', "TEXT NOT NULL DEFAULT ''"], ['probe_after', 'INTEGER NOT NULL DEFAULT 0'],
    ['probe_token', "TEXT NOT NULL DEFAULT ''"], ['probe_until', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE runner_unavailable ADD COLUMN ${name} ${type}`);
  }
}

/** Record the failed call and confirming health result together, resetting only this host's recovery generation. */
export function recordRunnerFailure(db, host, reason, diagnostic, { quarantine = true } = {}) {
  if (diagnostic) db.prepare(`INSERT INTO runner_transport_error(host,at,diagnostic) VALUES(?,?,?)
    ON CONFLICT(host) DO UPDATE SET at=excluded.at,diagnostic=excluded.diagnostic`)
    .run(host, new Date().toISOString(), JSON.stringify(diagnostic));
  if (!quarantine && reason !== 'cleanup-unverified') return;
  db.prepare(`INSERT INTO runner_unavailable(host,since,detail,failure,probe_after,probe_token,probe_until)
    VALUES(?,?,?,?,?,'',0) ON CONFLICT(host) DO UPDATE SET since=excluded.since,detail=excluded.detail,
    failure=excluded.failure,probe_after=excluded.probe_after,probe_token='',probe_until=0`)
    .run(host, new Date().toISOString(), reason === 'cleanup-unverified' ? 'CLEANUP_UNVERIFIED' : 'TRANSPORT_LOST',
      diagnostic ? JSON.stringify({ original: diagnostic }) : '', Date.now() + 1_000);
}

/** Probe each due transport generation once across all queue clients; never infer cleanup or clear a newer failure. */
export async function recoverUnavailableRunners(db, runners, { probe = probeRunnerTransport } = {}) {
  const configured = new Map(runners.map(runner => [runner.host, runner]));
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM runner_unavailable WHERE detail='TRANSPORT_LOST' AND failure<>''
    AND probe_after<=? AND probe_until<=? AND NOT EXISTS(SELECT 1 FROM runner_draining WHERE host=runner_unavailable.host)`)
    .all(now, now).filter(row => configured.has(row.host));
  const results = await Promise.all(rows.map(async row => {
    const token = randomUUID();
    const claimed = db.prepare(`UPDATE runner_unavailable SET probe_token=?,probe_until=? WHERE host=? AND since=?
      AND detail='TRANSPORT_LOST' AND probe_until<=? AND probe_after<=?`).run(token, now + 5_000, row.host, row.since, now, now).changes;
    if (!claimed) return false;
    let result;
    try { result = await probe(configured.get(row.host)); }
    catch { result = { healthy: false, reason: 'health observation unavailable' }; }
    if (result.healthy) {
      return db.prepare(`DELETE FROM runner_unavailable WHERE host=? AND since=? AND probe_token=? AND detail='TRANSPORT_LOST'
        AND NOT EXISTS(SELECT 1 FROM runner_draining WHERE host=runner_unavailable.host)`)
        .run(row.host, row.since, token).changes > 0;
    }
    let retained;
    try { retained = JSON.parse(row.failure); } catch { retained = { original: { reason: 'legacy diagnostic unreadable' } }; }
    db.prepare(`UPDATE runner_unavailable SET probe_token='',probe_until=0,probe_after=?,failure=?
      WHERE host=? AND since=? AND probe_token=? AND detail='TRANSPORT_LOST'`)
      .run(Date.now() + 1_000, JSON.stringify({ ...retained, latestProbe: result }), row.host, row.since, token);
    return false;
  }));
  return results.some(Boolean);
}
