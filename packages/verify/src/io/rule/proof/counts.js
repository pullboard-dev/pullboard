/** Read indexed rule proof without Git subprocesses or replaying raw gate history [S1,A1,A2,C7]. */
import { repoInfo } from '../../../../../git/index.js';
import { trunkRevisionReader } from '../../../../../git/index.js';
import {
  currentProofCounters,
  proofCounter,
  proofCounterRows,
} from '../../proof/counters.js';
import { proofCoverageFingerprint } from './coverage.js';
import { receiptFields } from '../../../logic/proof/provenance.js';
const WEEK = 7 * 86_400_000;
const FILE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:[cm]?js|cts)$/u;

/** Read only native red receipt candidates in bounded batches when an older projection cannot answer. */
function legacyRedRuns(board) {
  const read = board.db.prepare(`SELECT event_id,event_detail FROM event WHERE event_id>? AND event_kind='gate-run'
    AND event_by='coordinator' AND json_extract(CASE WHEN json_valid(event_detail) THEN event_detail ELSE '{}' END,'$.run.green')=0
    ORDER BY event_id LIMIT 256`);
  const runs = [];
  let cursor = 0;
  while (true) {
    const batch = read.all(cursor);
    if (!batch.length) return runs;
    for (const row of batch) {
      cursor = row.event_id;
      const run = receiptFields(JSON.parse(row.event_detail).run);
      if (run && !run.green && run.head === run.main) runs.push({ event: row.event_id, kind: run.kind, at: run.at,
        files: [...new Set(run.failures.map(failure => failure.file))] });
    }
  }
}

/** Readers never warm indexes; only red history has a legacy fallback, and green coverage stays unknown. */
function redRuns(board) {
  try { if (currentProofCounters(board)) return proofCounterRows(board, 'rule-red'); }
  catch { /* An unreadable disposable projection cannot erase authoritative red history. */ }
  return legacyRedRuns(board);
}

/** Only explicit test-file declarations identify a machine gate; review and opaque commands do not. */
function rowFiles(row) {
  const files = String(row.gate ?? '').split(',').map(file => file.trim().replace(/^\.\//u, ''));
  return files.length && files.every(file => FILE.test(file) && !file.split('/').includes('..')) ? files : [];
}

/** Current immutable source tuples prove coverage; recent indexed reds remain an independent count. */
export function ruleProofCounts(root, board, rows, { now = board.clock.now().getTime() } = {}) {
  const approved = rows.filter(row => row.status === 'approved');
  const gated = approved.filter(row => String(row.gate ?? '').trim());
  const counts = { approved: approved.length, gated: gated.length, ungated: approved.length - gated.length, proven: 0, unproven: gated.length, contradicted: 0 };
  if (!gated.length) return counts;
  const failures = new Set(redRuns(board).filter(run => ['gate', 'land'].includes(run.kind)
    && Date.parse(run.at) <= now && Date.parse(run.at) >= now - WEEK).flatMap(run => run.files));
  counts.contradicted = gated.filter(row => rowFiles(row).some(file => failures.has(file))).length;
  try {
    if (!currentProofCounters(board)) return counts;
    const head = trunkRevisionReader(repoInfo(root))();
    if (!head) return counts;
    const fingerprint = proofCoverageFingerprint();
    const source = proofCounter(board, `rule-green:${head}:${fingerprint}`);
    if (!source || source.head !== head || source.fingerprint !== fingerprint) return counts;
    if (source.runtime !== null && source.runtime !== process.execPath) return counts;
    const included = new Set(source.files);
    counts.proven = gated.filter(row => { const files = rowFiles(row); return files.length > 0 && files.every(file => included.has(file)); }).length;
    counts.unproven = gated.length - counts.proven;
  } catch { /* Unknown legacy coverage remains unproven; a read never re-derives it with Git. */ }
  return counts;
}

/** Indexed red timestamps expire independently of green proof and board mutation. */
export function ruleProofWindow(board, now) {
  const at = Date.parse(now);
  const candidates = redRuns(board);
  const active = candidates.filter(run => Date.parse(run.at) <= at && Date.parse(run.at) >= at - WEEK);
  const boundaries = candidates.flatMap(run => [Date.parse(run.at), Date.parse(run.at) + WEEK + 1]).filter(time => time > at);
  return { events: active.map(run => run.event), nextExpiry: boundaries.length ? new Date(boundaries.reduce((a, b) => Math.min(a, b))).toISOString() : null };
}
