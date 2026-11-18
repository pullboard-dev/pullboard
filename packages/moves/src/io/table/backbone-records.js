/** Read each live job the board offered and say, by the backbone's serves rule for its kind, whether it still serves its item: U152's read-only trial [C7,#10580]. */
import { openBoardReadOnly } from '../../../../store/index.js';
import { BACKBONE_RULES } from '../../logic/table/backbone.table.js';
import { JOB_KINDS } from '../../logic/table/backbone.table.js';
import { servesRule } from '../../logic/table/backbone.table.js';
import { deriveFact } from '../../logic/table/rules.js';

/** The job steps of a job that still waits on, or holds, a runner: a finished job no longer claims a reason to exist. */
const LIVE_STEPS = Object.freeze(['offered', 'claimed']);

/**
 * The job inputs each read kind's serves rule needs, and whether it reads an item. A kind not listed here is reported unreadable by kind.
 * Why a list: a job field the board never recorded makes the answer unknown, not false, so the trial never counts a missing input as a disagreement.
 */
const READS = Object.freeze({
  gate: { job: ['seat', 'commit', 'digest'], item: true },
  'gate-shard': { job: ['commit', 'digest'], item: true },
  'gate-verdict': { job: ['commit', 'digest'], item: true },
  'check-baseline': { job: [], item: true },
  'main-test': { job: [], item: false },
  'cells-inventory': { job: [], item: false },
  test: { job: ['seat'], item: false },
  'test-run': { job: ['seat'], item: false },
});

const LISTED = new Set(JOB_KINDS.map(job => job.kind));

/** A JSON payload as an object; a damaged one reads as empty. */
function parsed(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** The job's request: the whole request step when the offer was trimmed, else the offered row's copy. */
function requestOf(db, id) {
  const steps = db.prepare("SELECT job_step_name, job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name IN ('request', 'offered') ORDER BY job_step_seq").all(id);
  const whole = steps.find(step => step.job_step_name === 'request');
  const offered = steps.find(step => step.job_step_name === 'offered');
  return parsed(whole?.job_step_payload).request ?? parsed(offered?.job_step_payload).request ?? {};
}

/** The backbone's job: its kind, the commit it runs, and the seat and frozen digest its submit named, as the board recorded them. */
function jobOf(row, request) {
  const submit = request?.submit ?? {};
  return { kind: row.job_kind, commit: submit.commit ?? row.job_candidate ?? undefined, digest: submit.digest ?? request?.digest ?? undefined,
    seat: submit.agentId ?? request?.seat ?? undefined, base: row.job_base ?? undefined };
}

/** The backbone's item from its stored row; an empty check reads as none. */
function itemOf(row) {
  return { id: row.item_id, status: row.item_status, owner: row.item_owner, commit: row.item_commit, digest: row.item_frozen_digest,
    reservedBy: row.item_review_by, check: row.item_check ? row.item_check : null };
}

/**
 * One live job's answer: served or unserved with the facts that failed, or unreadable naming the kind or the job fields the rule needs and the board never recorded.
 *
 * @returns {{ job: string, kind: string, item: number | null, outcome: 'served' | 'unserved' | 'unreadable', failing?: string[], missing?: string[] }}
 */
function judge(db, row, readItem) {
  const base = { job: row.job_id, kind: row.job_kind, item: row.job_item ?? null };
  const reads = READS[row.job_kind];
  if (!LISTED.has(row.job_kind) || !reads) return { ...base, outcome: 'unreadable', missing: [`kind ${row.job_kind}`] };
  const job = jobOf(row, requestOf(db, row.job_id));
  const missing = reads.job.filter(field => job[field] === undefined || job[field] === null).map(field => `job.${field}`);
  const item = row.job_item === null || row.job_item === undefined ? null : readItem(row.job_item);
  if (reads.item && !item) missing.push('item');
  if (missing.length) return { ...base, outcome: 'unreadable', missing };
  const rule = servesRule(row.job_kind);
  const answer = deriveFact(BACKBONE_RULES, rule, { item, items: [], job, base: null, history: [] });
  if (answer.holds) return { ...base, outcome: 'served' };
  const failing = answer.trace.filter(step => !step.holds && step.fact !== rule).map(step => step.fact);
  return { ...base, outcome: 'unserved', failing: failing.length ? failing : [rule] };
}

/**
 * Read every live job offered at or after `since` and judge it by the backbone, read-only.
 * Why: the serves facts are U152's derived facts, and until now no code read them over the board's own rows (pullboard moves showed backbone as map).
 *
 * @param {string | { db: import('node:sqlite').DatabaseSync }} board - A board file path, or an open board (only SELECTed).
 * @param {{ since: string }} options - ISO time; jobs created at or after it are read.
 * @returns {{ records: object[] }}
 */
export function readBackboneRecords(board, { since }) {
  const opened = typeof board === 'string' ? openBoardReadOnly(board) : null;
  try {
    const db = opened ?? board.db;
    const from = Date.parse(since);
    const items = db.prepare('SELECT item_id, item_status, item_owner, item_commit, item_frozen_digest, item_review_by, item_check FROM item WHERE item_id = ?');
    const readItem = id => { const row = items.get(id); return row ? itemOf(row) : null; };
    const rows = db.prepare(`SELECT job_id, job_kind, job_item, job_candidate, job_base FROM job WHERE job_created >= ? AND job_step IN (${LIVE_STEPS.map(() => '?').join(', ')}) ORDER BY job_created, job_id`)
      .all(Number.isFinite(from) ? from : 0, ...LIVE_STEPS);
    return { records: rows.map(row => judge(db, row, readItem)) };
  } finally {
    if (opened) opened.close();
  }
}

/**
 * The counts over a set of records: compared is served plus unserved (an unreadable job is not a compare), and the same per kind.
 *
 * @param {{ outcome: string, kind: string }[]} records
 * @returns {{ compared: number, served: number, unserved: number, unreadable: number, byKind: Record<string, { served: number, unserved: number, unreadable: number }> }}
 */
export function backboneSummary(records) {
  const total = { compared: 0, served: 0, unserved: 0, unreadable: 0, byKind: {} };
  for (const { outcome, kind } of records) {
    total[outcome] += 1;
    if (outcome !== 'unreadable') total.compared += 1;
    total.byKind[kind] ??= { served: 0, unserved: 0, unreadable: 0 };
    total.byKind[kind][outcome] += 1;
  }
  return total;
}
