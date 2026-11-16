/** Read gate hand-off records from the board and phase spans from the machine's span files, read-only [C7]. */
import { gateSpanFolder } from '../../../jobs/index.js';
import { readGateSpans } from '../../../jobs/index.js';
import { readRunnerTime } from '../../../jobs/index.js';
import { runnerTimeFolder } from '../../../jobs/index.js';
import { gateHealthSummary } from '../logic/health.js';
import { runnerTimeSummary } from '../logic/runner-time.js';

/** How far before the window a retried gate's first job is looked for. */
const CHAIN_LOOKBACK_MS = 6 * 3_600_000;

/** True when the board has both job tables; an older board holds no hand-off record. */
function hasJobTables(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('job', 'job_step')").get().n === 2;
}

/** The newest step record of each named gate job, with the job's item. */
function jobRecords(db, rows) {
  const records = new Map();
  const step = db.prepare(`SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_payload LIKE '%"record"%'
    ORDER BY job_step_id DESC LIMIT 1`);
  for (const row of rows) {
    const found = step.get(row.id);
    if (!found) continue;
    let record;
    try { record = JSON.parse(found.payload).record; } catch { continue; /* a malformed step carries no record */ }
    if (record?.id) records.set(record.id, { ...record, item: row.item });
  }
  return records;
}

/**
 * The gate health report for one window: every gate job updated since the window opened (and the earlier jobs it
 * retried), and every span that ended in it.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board, read only.
 * @param {{ commonDir: string, since: number, now: number, ledgerRows?: object[] }} window - `ledgerRows`: the board's recorded test_result rows, the only source of the red list.
 * @returns {ReturnType<typeof gateHealthSummary>}
 */
export function gateHealthReport(db, { commonDir, since, now, ledgerRows = [] }) {
  const records = hasJobTables(db)
    ? jobRecords(db, db.prepare("SELECT job_id AS id, job_item AS item FROM job WHERE job_kind = 'gate' AND job_updated >= ?").all(since - CHAIN_LOOKBACK_MS))
    : new Map();
  return gateHealthSummary({ records: [...records.values()], spans: readGateSpans(gateSpanFolder(commonDir), { since: since - CHAIN_LOOKBACK_MS, now }), since, now, ledgerRows });
}

/**
 * The runner minutes by purpose and the unattributed share for one window, from the runner-time sidecar: every runner
 * dispatch that ended in it, whether or not a gate or landing run was open (#8184).
 *
 * @param {{ commonDir: string, since: number, now: number }} window
 * @returns {ReturnType<typeof runnerTimeSummary>}
 */
export function runnerTimeReport({ commonDir, since, now }) {
  return runnerTimeSummary(readRunnerTime(runnerTimeFolder(commonDir), { since, now }));
}
