/**
 * A pulled gate red that names failed files but no cases, compared with main by file. Why apart from the case
 * comparison: Node's native spec reporter prints no TAP account, so its cases cannot be named, yet its failure footer
 * still says which files failed, and the inline gate compared those files with main (compareMainFailures) [V1,C7].
 */

import { tryGit } from '../../../../git/index.js';
import { CONFIG_FILE } from '../../../../kernel/browser.js';

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
/** The main-red notes this process's board API words reds with; null until a host provides them. */
let mainRedNotes = null;

/**
 * Provide the inline gate's main-red wording: message(root, board, comparison) words files red on main as the
 * inline submit's refusal does, naming the one open rework an approved row's gate file gives it. Why a provider: the
 * wording and its rework match (mainRedMessage, matchingReworks) live in the landing cell, which the board API does
 * not import, so `pullboard serve` provides them once at start; null removes them [V1,C7].
 * @param {{ message: (root: string, board: any, comparison: { main: string, files: { file: string, result: 'red' }[] }) => string } | null} notes
 */
export function provideMainRedNotes(notes) {
  mainRedNotes = typeof notes?.message === 'function' ? notes : null;
}

/**
 * The provided main-red wording for files red on main, one line per line it says: the owning rework and the next
 * step when one open rework owns them, else "also red on main"; an accepted red drops the next step, since nothing is
 * submitted again. None when no host provided the wording or it cannot read main.
 *
 * @param {any} board
 * @param {string} main
 * @param {string[]} files
 * @param {{ accepted?: boolean }} [options]
 * @returns {string[]}
 */
export function mainRedLines(board, main, files, { accepted = false } = {}) {
  if (!mainRedNotes || !board.gitRoot || !files.length) return [];
  let said = '';
  try { said = String(mainRedNotes.message(board.gitRoot, board, { main, files: files.map(file => ({ file, result: 'red' })) }) ?? ''); }
  catch (error) { if (!error?.code) throw error; }
  return said.split('\n').filter(line => line.trim() && !(accepted && line.startsWith('next: ')));
}

/**
 * The lines naming the open rework that owns a compared red's cases main fails too, with "also red on main"; none
 * when no single rework owns them. Why: the inline gate named that rework, so a builder whose red is main's knows
 * which item to land first [V1,C7].
 *
 * @param {any} board
 * @param {string} main
 * @param {{ cases: { file: string, onMain: boolean | null }[] } | null} compared
 * @param {{ accepted?: boolean }} [options]
 * @returns {string[]}
 */
export function caseReworkLines(board, main, compared, options) {
  const files = [...new Set((compared?.cases ?? []).filter(row => row.onMain === true).map(row => row.file))];
  const lines = mainRedLines(board, main, files, options);
  return lines.some(line => line.startsWith('inherited main red')) ? [`also red on main: ${files.join(', ')}`, ...lines] : [];
}
const PROJECT_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r]{1,4096}$/u;

/** True when accepted main's committed config names a focused test runner (affectedTests); unreadable reads as one, so nothing is claimed. */
function focusedRunner(root, main) {
  let config;
  try { const shown = tryGit(root, ['show', `${main}:${CONFIG_FILE}`]); if (shown.status !== 0) return true; config = JSON.parse(shown.stdout); } catch { return true; }
  return typeof config?.affectedTests === 'string' && config.affectedTests.trim() !== '';
}

/** True when the main-test job's keyed receipt records a run that only went over its file budget. */
function budgetOnlyReceipt(db, receipt) {
  const id = typeof receipt === 'string' ? receipt : receipt?.id;
  if (typeof id !== 'string') return false;
  const row = db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' AND job_step_seq = 0").get(id);
  try { return JSON.parse(row?.payload ?? 'null')?.budgetOnly === true; } catch { return false; }
}

/**
 * Compare the failed files of a red gate receipt with main's receipts, when its red phases name files (failedFiles,
 * read on the runner from the spec reporter's failure footer) and no cases. Each file comes back red or green on
 * main, or missing (result null) with the main-test job the lookup queued to measure it. Nothing runs here.
 *
 * @param {any} board - The open board, gitRoot set to the board host's repository.
 * @param {Record<string, any>} receipt
 * @param {string} main - The accepted main the gate job was offered against.
 * @param {((request: { root: string, db: import('node:sqlite').DatabaseSync, main: string, cases: object[], files: string[], inputKeys: Record<string, string> }) =>
 *   { files?: { file: string, result: 'red' | 'green' | null, receipt: string | null, job: string | null }[] } | null) | null} lookup
 * @returns {{ main: string, files: { file: string, result: 'red' | 'green' | null, receipt: string | null, job: string | null }[], jobs: string[], unavailable?: string } | null}
 *   unavailable says why main was not checked, with no files: main's config names no focused runner (affectedTests), or no
 *   red phase names a failed file or case; null when the red
 *   is not only test phases without cases, no lookup is given (gate.mainComparison off), or main's receipts cannot be keyed.
 */
export function compareFilesWithMain(board, receipt, main, lookup) {
  const gate = receipt?.gate ?? {};
  if (typeof lookup !== 'function' || !board.gitRoot || !SHA.test(String(main)) || gate.error || gate.analysis?.infra || gate.analysis?.refusals?.length || gate.analysis?.ownership || gate.proofPlan) return null;
  const red = (gate.phases ?? []).filter(phase => phase.status !== 0);
  if (!red.length) return null;
  // With no focused runner in accepted main's config, nothing can be measured on main, cases or not, so it says so.
  if (!focusedRunner(board.gitRoot, main)) return { main, files: [], jobs: [], unavailable: 'no focused test runner configured' };
  if (red.some(phase => Array.isArray(phase.failures) && phase.failures.length)) return null;
  const files = [...new Set(red.flatMap(phase => Array.isArray(phase.failedFiles) ? phase.failedFiles : []))].filter(file => typeof file === 'string' && PROJECT_FILE.test(file));
  // A red that names neither cases nor files is never guessed to be main's: it says why main was not checked.
  if (!files.length) return { main, files: [], jobs: [], unavailable: 'could not read which tests failed' };
  let found = null;
  try { found = lookup({ root: board.gitRoot, db: board.db, main, cases: [], files, inputKeys: ledgerInputKeys(red) }); } catch (error) { if (!error?.code) throw error; }
  const rows = new Map((Array.isArray(found?.files) ? found.files : []).map(row => [row.file, row]));
  if (files.some(file => !rows.has(file))) return null;
  const compared = files.map(file => {
    const row = rows.get(file);
    // A budget-only main run failed no case: main's file reads green here, so a file's own unnamed failure is never excused by a budget overrun [C7,#12692].
    const result = row.result === 'red' && budgetOnlyReceipt(board.db, row.receipt) ? 'green' : ['red', 'green'].includes(row.result) ? row.result : null;
    return { file, result, receipt: row.receipt ?? null, job: row.job ?? null, absentOnMain: result === null && tryGit(board.gitRoot, ['cat-file', '-e', `${main}:${file}`]).status !== 0 };
  });
  return { main, files: compared, jobs: [...new Set(compared.map(row => row.job).filter(Boolean))] };
}

/**
 * Each failed file's test input key, read from the red phases' proof-ledger rows: the key hashes the file, its whole
 * import closure and its declared inputs. Why: main's lookup then takes a receipt another main recorded under the same
 * key, so a main that moved only outside the file's closure still answers [C7,SC11]. A file with no keyed row is left out.
 *
 * @param {Record<string, any>[]} phases
 * @returns {Record<string, string>}
 */
export function ledgerInputKeys(phases) {
  const keys = {};
  for (const phase of phases) {
    for (const row of Array.isArray(phase?.ledger?.files) ? phase.ledger.files : []) {
      if (Array.isArray(row) && typeof row[0] === 'string' && PROJECT_FILE.test(row[0]) && /^[0-9a-f]{64}$/u.test(row[1] ?? '')) keys[row[0]] = row[1];
    }
  }
  return keys;
}

/**
 * The gate fact's lines for a file comparison, worded as the inline gate's refusal words them: why main was not
 * checked, or the files main also fails (with the open rework that owns them, through the provided wording) and each
 * file main's receipt is still missing for. A file green on main is the change's own red and adds no line, as before. A file absent from main can never get a main receipt, so its line says the red is the item's own.
 *
 * @param {any} board
 * @param {NonNullable<ReturnType<typeof compareFilesWithMain>>} compared
 * @returns {string[]}
 */
export function fileMainLines(board, compared) {
  if (compared.unavailable === 'no focused test runner configured') return ['main not checked: no focused test runner configured (affectedTests)'];
  if (compared.unavailable) return [`main not checked: ${compared.unavailable}`];
  const red = compared.files.filter(row => row.result === 'red').map(row => row.file);
  const said = mainRedLines(board, compared.main, red);
  return [...(red.length ? [`also red on main: ${red.join(', ')}`] : []), ...said.filter(line => !line.startsWith('also red on main')),
    ...compared.files.filter(row => row.result === null).map(row => row.absentOnMain
      ? `not on main: ${row.file} is new in this item; the red is the item's own, fix the test or the code, do not resubmit unchanged`
      : `main receipt missing: ${row.file}${row.job ? `; main-test job ${row.job} records it; next: wait for that job, do not resubmit` : ''}`)];
}
