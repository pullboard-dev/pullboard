/** Shared SQLite generations keep transport recovery separate from cleanup and capacity policy [C7]. */
import { randomUUID } from 'node:crypto';
import { healDelay } from './runner-leak-heal.js';
import { healLeakedRunner } from './runner-leak-heal.js';
import { probeStanding } from '../../../transport/index.js';

/** Doubts about a runner that only its transport probe settles: one good probe lifts them, two failures 30 s apart quarantine. */
export const PROBE_DOUBTS = ['CLEANUP_UNVERIFIED', 'TRANSPORT_UNVERIFIED'];

/** Accept only controller-issued exact-job identities; absence is legacy custody, never proof of cleanup. */
export function recoveryIdentity(value) {
  return value?.version === 1 && (value.launchFence === undefined || value.launchFence === 1) && /^[A-Za-z0-9_-]{1,100}$/u.test(value.request ?? '')
    && /^[a-f0-9-]{36}$/u.test(value.nonce ?? '') && /^[a-f0-9]{64}$/u.test(value.tooling ?? '');
}

/** Extend existing queues without rewriting legacy holds or changing configured capacity. */
export function initializeRunnerRecovery(db) {
  db.exec('CREATE TABLE IF NOT EXISTS runner_transport_error(host TEXT PRIMARY KEY,at TEXT NOT NULL,diagnostic TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS runner_recovery_event(id TEXT PRIMARY KEY,host TEXT NOT NULL,at TEXT NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS runner_probe(host TEXT NOT NULL,at INTEGER NOT NULL,ok INTEGER NOT NULL)');
  const columns = new Set(db.prepare('PRAGMA table_info(runner_unavailable)').all().map(row => row.name));
  for (const [name, type] of [['failure', "TEXT NOT NULL DEFAULT ''"], ['probe_after', 'INTEGER NOT NULL DEFAULT 0'],
    ['probe_token', "TEXT NOT NULL DEFAULT ''"], ['probe_until', 'INTEGER NOT NULL DEFAULT 0'], ['probe_attempts', 'INTEGER NOT NULL DEFAULT 0'], ['healing', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE runner_unavailable ADD COLUMN ${name} ${type}`);
  }
}

/**
 * Record one transport probe answer for a host. A good answer clears the host's earlier failures, since only failures
 * with no answer between them count toward a quarantine (the transport cell's rule).
 */
export function recordRunnerProbe(db, host, ok, at = Date.now()) {
  if (ok) db.prepare('DELETE FROM runner_probe WHERE host=?').run(host);
  db.prepare('INSERT INTO runner_probe(host,at,ok) VALUES(?,?,?)').run(host, at, ok ? 1 : 0);
  db.prepare('DELETE FROM runner_probe WHERE host=? AND at < (SELECT MIN(at) FROM (SELECT at FROM runner_probe WHERE host=? ORDER BY at DESC LIMIT 16))').run(host, host);
}

/** Whether the host's transport probes quarantine it: two failures at least 30 s apart with no good answer between. */
export function probeQuarantined(db, host) {
  try { return probeStanding(db.prepare('SELECT at,ok FROM runner_probe WHERE host=? ORDER BY at').all(host).map(row => ({ at: row.at, ok: row.ok === 1 }))).quarantined; }
  catch { return false; }
}

/** Whether any transport probe has answered for the host since the given ISO time. */
function probedSince(db, host, since) {
  try { return (db.prepare('SELECT MAX(at) AS at FROM runner_probe WHERE host=?').get(host)?.at ?? -1) >= Date.parse(since); }
  catch { return false; }
}

/**
 * Whether an unavailable row takes its whole runner out of admission. A cleanup or transport doubt is never a
 * quarantine on its own: only two failed transport probes 30 s apart are, or a heal's fence while it stands. A lost
 * transport holds the runner only until its first probe answers (about a second); an unverified cleanup costs its
 * slot, and the runner is out only when every slot is charged. Any other recorded failure keeps the runner out.
 */
export function runnerExcluded(db, row, { charges, slots, now = Date.now() }) {
  if (row.healing === 1 && row.probe_until > now) return true;
  if (!PROBE_DOUBTS.includes(row.detail)) return true;
  if (probeQuarantined(db, row.host)) return true;
  if (row.detail === 'TRANSPORT_UNVERIFIED') return !probedSince(db, row.host, row.since);
  return !(charges.get(row.host) < (slots.get(row.host) ?? 0));
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
      JSON.stringify(failure), Date.now() + (reason === 'worker-unresponsive' ? 0 : 1_000));
  });
}

/**
 * Slots each runner loses to unverified cleanups: one per job whose cleanup is still unproven.
 * Why: one job's cleanup timeout under load said nothing about the runner's other slots, yet it
 * quarantined the whole runner for an hour while healthy jobs held it and blocked its idle proof.
 */
export function cleanupCharges(db) {
  const charges = new Map();
  for (const row of db.prepare("SELECT host, failure FROM runner_unavailable WHERE detail = 'CLEANUP_UNVERIFIED'").all()) {
    let pending;
    try { pending = JSON.parse(row.failure)?.pending; } catch { pending = null; }
    // One job is one slot however often its failure is recorded; an unidentified failure counts on its own.
    const jobs = Array.isArray(pending) ? new Set(pending.map(entry => recoveryIdentity(entry) ? entry.request + ':' + entry.nonce : Symbol('unknown'))) : new Set();
    charges.set(row.host, Math.max(1, jobs.size));
  }
  return charges;
}

/** Probe due failed generations outside transactions; only exact or explicit idle proofs restore availability. */
export async function recoverUnavailableRunners(db, runners, { probe, idleProbe, restartProbe, leakProbe, transportProbe, now = Date.now() } = {}) {
  if (typeof probe !== 'function') return false;
  const configured = new Map(runners.map(runner => [runner.host, runner]));
  const rows = db.prepare(`SELECT * FROM runner_unavailable WHERE probe_after<=? AND probe_until<=?
    AND NOT EXISTS(SELECT 1 FROM runner_draining WHERE host=runner_unavailable.host)`)
    .all(now, now).filter(row => configured.has(row.host));
  const results = await Promise.all(rows.map(async row => {
    const token = randomUUID();
    let claimed;
    try {
      claimed = db.prepare(`UPDATE runner_unavailable SET probe_token=?,probe_until=? WHERE host=? AND since=?
        AND probe_until<=? AND probe_after<=?`).run(token, now + 10_000, row.host, row.since, now, now).changes;
    } catch (error) {
      // Recovery is best effort: a locked slot database skips this round with the row unchanged, and the next pass
      // retries. A thrown lock ended the landing worker mid-gate three times in 30 minutes on 5 Nov [C7].
      if (/database is locked|SQLITE_BUSY/u.test(String(error?.message ?? error))) return false;
      throw error;
    }
    if (!claimed) return false;
    let retained;
    try { retained = JSON.parse(row.failure); } catch { retained = { original: null }; }
    const pending = retained.pending ?? [retained.original?.recovery ?? null];
    let result;
    // A doubt is settled by the transport probe alone: one good answer puts the runner back in service [C7,P7].
    if (typeof transportProbe === 'function' && PROBE_DOUBTS.includes(row.detail)) {
      let answer;
      try { answer = await transportProbe(configured.get(row.host)); } catch { answer = { ok: false }; }
      try { recordRunnerProbe(db, row.host, answer?.ok === true, now); } catch { /* A locked probe history skips this record; the next pass probes again. */ }
      if (answer?.ok === true) result = { healthy: true, step: 'transport probe', reason: 'the runner answered its transport probe' };
    }
    const legacy = !pending.length || !pending.every(recoveryIdentity);
    if (result?.healthy === true) { /* Lifted by the transport probe. */ }
    else if (legacy) {
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
      // A lost transport whose SSH answers but whose pinned worker resets the probe is a hung worker too (#3128).
      const unresponsive = ['WORKER_UNRESPONSIVE', 'CLEANUP_UNVERIFIED', 'TRANSPORT_UNVERIFIED'].includes(row.detail) && result?.step === 'worker readiness';
      const failedProbe = unresponsive ? result : null;
      if (result?.healthy !== true && (result?.idleRequired === true || unresponsive) && typeof idleProbe === 'function') {
        try { result = await idleProbe(configured.get(row.host), pending); }
        catch { result = { healthy: false, step: 'idle proof', reason: 'exact launch idle observation unavailable' }; }
        if (result?.healthy !== true || result.idle !== true || result.writable !== true)
          result = { ...result, healthy: false, step: 'idle proof', reason: result?.reason ?? 'exact launch idle and writable proof missing' };
      }
      if (failedProbe) db.prepare('INSERT INTO runner_recovery_event VALUES(?,?,?,?,?)')
        .run(randomUUID(), row.host, new Date().toISOString(), 'worker-probe-failed', JSON.stringify({ failedProbe, workerState: result }));
      // An idle runner whose pinned worker will not answer restarts that worker itself; a busy one is left alone and named (#2035).
      if (failedProbe && ['WORKER_UNRESPONSIVE', 'TRANSPORT_UNVERIFIED'].includes(row.detail) && result?.healthy !== true && typeof restartProbe === 'function') {
        let restart;
        try { restart = await restartProbe(configured.get(row.host)); }
        catch { restart = { healthy: false, step: 'idle proof', reason: 'worker restart observation unavailable' }; }
        const restarted = Array.isArray(restart?.restarted) ? restart.restarted : [];
        if (restart?.healthy !== true || restart.idle !== true || restart.writable !== true)
          restart = { ...restart, healthy: false, step: 'idle proof', reason: restart?.reason ?? 'worker restart proof missing' };
        if (restarted.length) db.prepare('INSERT INTO runner_recovery_event VALUES(?,?,?,?,?)')
          .run(randomUUID(), row.host, new Date().toISOString(), 'worker-restarted', JSON.stringify({ restarted, workerState: restart }));
        result = restart;
      }
    }
    // A lost transport leaves the same doubt as an unverified cleanup: did the job's processes survive? The leak probe answers it [C7].
    if (result?.healthy !== true && ['CLEANUP_UNVERIFIED', 'TRANSPORT_UNVERIFIED'].includes(row.detail)) result = await healLeakedRunner(db, row, configured.get(row.host), result, { idleProbe, leakProbe, token, now });
    if (result?.healthy === true) {
      const recovered = auditedChange(db, () => {
      const removed = db.prepare(`DELETE FROM runner_unavailable WHERE host=? AND since=? AND probe_token=?
        AND NOT EXISTS(SELECT 1 FROM runner_draining WHERE host=runner_unavailable.host)`).run(row.host, row.since, token).changes > 0;
      if (removed) db.prepare('INSERT INTO runner_recovery_event VALUES(?,?,?,?,?)')
        .run(randomUUID(), row.host, new Date().toISOString(), 'available', JSON.stringify({ priorReason: row.detail, failure: retained.original, probe: result }));
      return removed;
      });
      if (recovered && row.detail === 'WORKER_UNRESPONSIVE')
        process.stderr.write(`runner ${row.host} recovered: pinned worker ready; ${result.reason ?? 'health proof passed'}\n`);
      return recovered;
    }
    const attempts = Math.min(16, row.probe_attempts + 1);
    // A cleanup re-check is cheap and the runner keeps its other slots, so it comes round every minute; a no-holder runner is healed twice as fast.
    const delay = row.detail === 'CLEANUP_UNVERIFIED' ? healDelay(db, row, leakProbe) : row.detail === 'WORKER_UNRESPONSIVE'
      ? 300_000 : Math.min(60_000, 1_000 * 2 ** Math.min(6, attempts));
    db.prepare(`UPDATE runner_unavailable SET probe_token='',probe_until=0,healing=0,probe_after=?,probe_attempts=?,failure=?
      WHERE host=? AND since=? AND probe_token=?`)
      .run(now + delay, attempts, JSON.stringify({ ...retained, latestProbe: result }), row.host, row.since, token);
    return false;
  }));
  return results.some(Boolean);
}
