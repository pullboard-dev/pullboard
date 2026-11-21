/**
 * The gate's main-red file excuse: a gate red only in proof test files that main also fails with the same inputs settles
 * for review, naming those files. Why: a file already red on main blocked every unrelated item whose gate ran it, and the
 * hand lander's exemption never acted, since the gate settled red before review was offered [C7,P7,#12130].
 *
 * "Red on main at the gate's base" is read with no Git on the settle path: the gate's own proof-ledger row gives each
 * failing file's input key (a hash of the file, its whole import closure and its declared inputs). A main-test receipt
 * for the file at that same key measured exactly these inputs, so the item's diff touched neither the file nor any
 * source it covers. The newest such receipt red counts, or any such receipt for a file on the coordinator's main-red
 * file list (board meta MAIN_RED_FILES_KEY). Anything else excuses nothing.
 */
import { readBoardMeta } from '../../../../store/index.js';
import { writeBoardMeta } from '../../../../store/index.js';
import { MAIN_TEST_KIND } from '../recheck.js';
import { ledgerInputKeys } from './files.js';

/** The board meta key holding the coordinator's main-red file list: a JSON array of repository paths. */
export const MAIN_RED_FILES_KEY = 'gate_main_red_files';

const INPUT_KEY = /^[0-9a-f]{64}$/u;
const PROJECT_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r]{1,4096}$/u;

/** The coordinator's main-red file list; empty when unset or unreadable. */
export function listedMainRedFiles(db) {
  let value = null;
  try { value = JSON.parse(readBoardMeta(db, MAIN_RED_FILES_KEY) ?? 'null'); } catch { value = null; }
  return Array.isArray(value) ? value.filter(file => typeof file === 'string' && PROJECT_FILE.test(file)) : [];
}

/** Replace the coordinator's main-red file list with `files` (repository paths, deduplicated and sorted). */
export function writeMainRedFiles(db, files) {
  const list = [...new Set((Array.isArray(files) ? files : []).filter(file => typeof file === 'string' && PROJECT_FILE.test(file)))].sort();
  writeBoardMeta(db, MAIN_RED_FILES_KEY, JSON.stringify(list));
  return list;
}

/**
 * A red phase's case rows: its failures[] and its errors[] together. A shard receipt often names its failing case only in
 * errors[], with failures[] empty, so reading failures[] alone would almost never excuse a red [C7,#12130].
 */
export function caseRows(phase) {
  return [...(Array.isArray(phase?.failures) ? phase.failures : []), ...(Array.isArray(phase?.errors) ? phase.errors : [])];
}

/**
 * The files a red phase names with no case: a file that failed as a whole (an import error, a crash) shows only in the
 * spec footer's failedFiles. Each is compared with main by its input key like a file with a failing case [C7,P7].
 */
function wholeFiles(phase) {
  return (Array.isArray(phase?.failedFiles) ? phase.failedFiles : []).filter(file => typeof file === 'string' && PROJECT_FILE.test(file));
}

/** The failing files' input keys a red phase carries: its own ledger rows, or the keys a combined shard receipt kept. */
function failingKeys(phase) {
  const kept = phase?.failedInputKeys && typeof phase.failedInputKeys === 'object' ? phase.failedInputKeys : {};
  return { ...ledgerInputKeys([phase]), ...kept };
}

/** The newest keyed main-test receipt for `file` measured at `inputKey`, or null. */
function mainReceiptAtKey(db, file, inputKey) {
  // Drive the join from main-test jobs. SQLite otherwise starts from all receipt steps to satisfy the timestamp sort.
  const row = db.prepare(`SELECT step.job_step_payload AS payload
    FROM job CROSS JOIN job_step AS step ON step.job_step_job = job.job_id
    WHERE job.job_kind = ? AND step.job_step_name = 'receipt' AND step.job_step_seq = 0
      AND json_extract(step.job_step_payload, '$.file') = ? AND json_extract(step.job_step_payload, '$.inputKey') = ?
    ORDER BY step.job_step_at DESC, step.job_step_id DESC LIMIT 1`).get(MAIN_TEST_KIND, file, inputKey);
  let keyed = null;
  try { keyed = row ? JSON.parse(row.payload) : null; } catch { keyed = null; }
  return keyed && ['red', 'green'].includes(keyed.verdict) ? { id: typeof keyed.id === 'string' ? keyed.id : null, verdict: keyed.verdict, main: typeof keyed.main === 'string' ? keyed.main : null } : null;
}

/**
 * The files a red gate receipt is excused for, each with the main receipt that excuses it; null when any part of the red
 * is not such a file: a job error, infrastructure, a refusal, a red check, a proof red naming no case, a failing file
 * with no input key, or one main never measured red at its key (listed files: measured at all).
 *
 * @param {{ db: import('node:sqlite').DatabaseSync }} board
 * @param {Record<string, any>} receipt
 * @returns {{ file: string, inputKey: string, receipt: string | null, verdict: 'red' | 'green', main: string | null, listed: boolean }[] | null}
 */
export function mainRedFileExcuse(board, receipt) {
  const gate = receipt?.gate ?? {};
  if (receipt?.status === 0 || gate.error || gate.analysis?.infra || gate.analysis?.refusals?.length || gate.analysis?.ownership || gate.proofPlan) return null;
  const red = (gate.phases ?? []).filter(phase => phase.status !== 0);
  if (!red.length || red.some(phase => phase.role !== 'proof' || !(caseRows(phase).length || wholeFiles(phase).length)
    || caseRows(phase).some(row => typeof row?.name !== 'string' || !row.name || !PROJECT_FILE.test(row?.file ?? '')))) return null;
  const keys = Object.assign({}, ...red.map(failingKeys));
  const listed = new Set(listedMainRedFiles(board.db));
  const excused = [];
  for (const file of [...new Set(red.flatMap(phase => [...caseRows(phase).map(row => row.file), ...wholeFiles(phase)]))]) {
    const inputKey = keys[file];
    if (!INPUT_KEY.test(inputKey ?? '')) return null;
    const main = mainReceiptAtKey(board.db, file, inputKey);
    if (!main || (main.verdict !== 'red' && !listed.has(file))) return null;
    excused.push({ file, inputKey, receipt: main.id, verdict: main.verdict, main: main.main, listed: listed.has(file) });
  }
  return excused.length ? excused : null;
}

/** One fact line per excused file: its input key, the main receipt at that key and whether the coordinator listed it. */
export function mainRedFileLines(excused) {
  return excused.map(row => `main-red file ${row.file} at input key ${row.inputKey.slice(0, 12)}: main-test receipt ${row.receipt ?? 'unnamed'} ${row.verdict}${row.main ? ` on main ${row.main.slice(0, 12)}` : ''}${row.listed ? '; on the coordinator\'s main-red file list' : ''}`);
}
