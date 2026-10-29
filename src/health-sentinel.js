import { dispatchHealth } from './dispatch-health.js';
import { rejectedWorkReturns } from './rejected-work-return.js';
/** Snapshot health without keeping a board write lock across Git's merge checks [A6]. */
import { existsSync } from 'node:fs';
import { openBoardReadOnly } from './board.js';
import { healthReport } from './health.js';
import { healthSentinelEnabled } from './settings.js';
import { Refused } from './refused.js';
import { agentCpuFindings } from './sentinel-cpu.js';
import {
  healthFindingIdentity,
  normalizedHealthFindings,
} from './board-health-receipts.js';

/** A missing board or an explicitly disabled sentinel has no observation to publish. */
export function scanHealthSentinel(file, { root, config, now, cpu = agentCpuFindings, returnRejected = false }) {
  if (!healthSentinelEnabled(config) || !existsSync(file)) return null;
  const db = openBoardReadOnly(file);
  try {
    db.exec('BEGIN');
    const observedRevision = db.prepare('SELECT COALESCE(MAX(event_id), 0) AS revision FROM event').get().revision;
    const report = healthReport({ db, root, config, now, dispatchHealth });
    const { dispatch } = dispatchHealth({ db, clock: { now: () => now } }, config);
    const last = db.prepare("SELECT event_detail FROM event WHERE event_kind = 'health-scan' ORDER BY event_id DESC LIMIT 1").get();
    const processes = cpu(db);
    report.stuck.push(...(processes ?? (last ? JSON.parse(last.event_detail).active : []).filter(finding => finding.cause === 'AGENT_CPU').map(finding => ({ ...finding, owner: { who: finding.owner } }))));
    const before = (last ? JSON.parse(last.event_detail).active : []).map(healthFindingIdentity).sort();
    const after = normalizedHealthFindings(report.stuck).map(healthFindingIdentity).sort();
    const priorDispatch = last ? JSON.parse(last.event_detail).dispatch ?? [] : [];
    const dispatchChanged = JSON.stringify(priorDispatch) !== JSON.stringify(dispatch);
    const pendingReturns = returnRejected ? rejectedWorkReturns({ db, clock: { now: () => now } }, report.stuck) : [];
    db.exec('COMMIT');
    if (!pendingReturns.length && !dispatchChanged && JSON.stringify(before) === JSON.stringify(after) && !(last && (JSON.parse(last.event_detail).pendingCpu?.length || JSON.parse(last.event_detail).pendingDispatch?.length))) return null;
    return { observedRevision, findings: report.stuck, ...(returnRejected ? { returnRejected: true } : {}), ...(dispatchChanged || priorDispatch.length ? { dispatch } : {}) };
  } finally { db.close(); }
}

/** Read the indexed last recorded findings and their recording time without running a health scan. */
export function recordedHealthFindings(board) {
  const last = board.db.prepare("SELECT event_at, event_detail FROM event WHERE event_kind = 'health-scan' ORDER BY event_id DESC LIMIT 1").get();
  if (!last) return { recordedAt: null, findings: [] };
  const detail = JSON.parse(last.event_detail);
  if (!Array.isArray(detail.active) || !Number.isFinite(Date.parse(last.event_at))) {
    throw new Refused('HEALTH_FINDINGS', 'the recorded health findings are invalid; run pullboard doctor before scheduling another sentinel run');
  }
  return { recordedAt: last.event_at, findings: detail.active };
}
