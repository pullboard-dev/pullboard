import { rejectedWorkReturns } from './rejected-work-return.js';
/** Snapshot health without keeping a board write lock across Git's merge checks [A6]. */
import { existsSync } from 'node:fs';
import { openBoardReadOnly } from './board.js';
import { healthReport } from './health.js';
import { healthSentinelEnabled } from './settings.js';
import { Refused } from './refused.js';
import {
  healthFindingIdentity,
  normalizedHealthFindings,
} from './health-receipts.js';

/** A missing board or an explicitly disabled sentinel has no observation to publish. */
export function scanHealthSentinel(file, { root, config, now, returnRejected = false }) {
  if (!healthSentinelEnabled(config) || !existsSync(file)) return null;
  const db = openBoardReadOnly(file);
  try {
    db.exec('BEGIN');
    const observedRevision = db.prepare('SELECT COALESCE(MAX(event_id), 0) AS revision FROM event').get().revision;
    const report = healthReport({ db, root, config, now });
    const last = db.prepare("SELECT event_detail FROM event WHERE event_kind = 'health-scan' ORDER BY event_id DESC LIMIT 1").get();
    const before = (last ? JSON.parse(last.event_detail).active : []).map(healthFindingIdentity).sort();
    const after = normalizedHealthFindings(report.stuck).map(healthFindingIdentity).sort();
    const pendingReturns = returnRejected ? rejectedWorkReturns({ db, clock: { now: () => now } }, report.stuck) : [];
    db.exec('COMMIT');
    if (JSON.stringify(before) === JSON.stringify(after) && !pendingReturns.length) return null;
    return { observedRevision, findings: report.stuck, ...(returnRejected ? { returnRejected: true } : {}) };
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
