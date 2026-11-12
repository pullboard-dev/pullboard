/**
 * The landing's main-red lookup [C7,#3424]: whether a failing file is red on base main is read from main's receipt,
 * keyed by (main tree, file, test command). A file whose receipt is missing enqueues one main-test job on the board and
 * is measured through the measuring port, which writes the receipt; a file with a receipt is never run again.
 */
import { createJob } from '../../../../../jobs/index.js';
import { jobView } from '../../../../../jobs/index.js';
import { writeStep } from '../../../../../jobs/index.js';
import { mainRedKey } from '../../../../../receipt/index.js';
import { mainRedStatus } from '../../../../../receipt/index.js';
import { MAIN_TEST_JOB } from '../../../../../receipt/index.js';
import { mainTestJobId } from '../../../../../receipt/index.js';
import { gitSpawnSync } from '../../../../../git/index.js';
import { policyAt } from '../../../../../sandbox/index.js';
import { cachedMainComparison } from '../red.js';
import { cacheFile } from '../red.js';
import { readCache } from '../red.js';
import { compareMainFailures } from '../red.js';

/** Main's tree id at a commit, or null when the commit cannot be read in `root`. */
function treeOf(root, commit) {
  const result = gitSpawnSync(['--no-replace-objects', 'rev-parse', '--verify', '--quiet', `${commit}^{tree}`], { cwd: root });
  const tree = result.status === 0 ? String(result.stdout).trim() : '';
  return /^[0-9a-f]{40,64}$/u.test(tree) ? tree : null;
}

/**
 * Whether a recorded comparison row is a complete receipt: the same bar compareMainFailures uses for a detailed reuse,
 * named cases for a red (or a whole-file isolation red) and a case list for a green.
 */
function completeRow(row) {
  return ['red', 'green'].includes(row?.result) && (Array.isArray(row.failures) || row.result === 'red' && row.fileIsolation === true);
}

/**
 * Main's receipts for these files at one commit, keyed by main's tree and the project's test command.
 *
 * @param {string} root
 * @param {string} commit - base main
 * @param {string[]} files
 * @returns {{ tree: string, command: string, receipts: Map<string, object>, rows: Map<string, object> } | null} null when
 *   main's tree or test command cannot be read, so nothing can be keyed.
 */
export function mainReceipts(root, commit, files) {
  const tree = treeOf(root, commit);
  const command = policyAt(root, commit)?.config?.affectedTests;
  if (!tree || typeof command !== 'string' || !command.trim()) return null;
  const cached = cachedMainComparison(root, commit, files);
  const receipts = new Map(), rows = new Map();
  for (const row of cached.files ?? []) {
    if (!completeRow(row)) continue;
    const key = mainRedKey(tree, row.file, command);
    receipts.set(key, { id: row.receiptId ?? key, tree, file: row.file, command, verdict: row.result,
      failing: (row.failures ?? []).map((main) => main.name), main: row.main ?? commit, at: row.at ?? null });
    rows.set(row.file, row);
  }
  return { tree, command, receipts, rows };
}

/**
 * Main's nearest receipt for one file on a later main: a commit after `commit` that main-test jobs measured the file
 * at, where the file is unchanged since `commit`. Why: main moves every few minutes, so a gate keyed to its exact main
 * never finds a receipt a queued job writes at a newer main, and a red only on missing receipts never settles [C7,P7].
 * Only the file's own content is compared; its imports are not followed.
 *
 * @param {string} root
 * @param {string} commit - the gate's main
 * @param {string} file
 * @returns {ReturnType<typeof mainReceipts> | null} the receipts at the nearest such main, or null when there is none.
 */
export function nearbyMainReceipts(root, commit, file) {
  let entries;
  try { entries = readCache(cacheFile(root)).entries; } catch { return null; }
  const quiet = (...args) => gitSpawnSync(['--no-replace-objects', ...args], { cwd: root }).status === 0;
  for (const later of Object.keys(entries)) {
    if (later === commit || !entries[later]?.[file] || !quiet('merge-base', '--is-ancestor', commit, later) || !quiet('diff', '--quiet', commit, later, '--', file)) continue;
    const known = mainReceipts(root, later, [file]);
    if (known && mainRedStatus(known.receipts, { tree: known.tree, file, command: known.command }).status !== 'missing') return known;
  }
  return null;
}

/**
 * Build the compare port the landing diagnose step uses: same arguments and result shape as compareMainFailures, but
 * answered from main's receipts. Every file with a receipt is answered from it (the result names its receipt ids); a
 * missing receipt enqueues its main-test job on `db` and the files are measured once through `measure`. A pinned or
 * fresh comparison is not a lookup and goes straight to `measure`.
 *
 * @param {{ db?: import('node:sqlite').DatabaseSync | null, measure?: typeof compareMainFailures, now?: () => number }} [ports]
 * @returns {typeof compareMainFailures}
 */
export function receiptComparison({ db = null, measure = compareMainFailures, now = Date.now } = {}) {
  return async function compareByReceipt(root, profile, onWait, output = '', options = {}) {
    const files = [...new Set((profile?.tests ?? []).filter((row) => row?.file && row.passed === false).map((row) => row.file))];
    if (!options.commit || options.execution !== undefined || options.fresh || !files.length) return measure(root, profile, onWait, output, options);
    let known;
    try { known = mainReceipts(root, options.commit, files); } catch { known = null; }
    if (!known) return measure(root, profile, onWait, output, options);
    const at = (file) => ({ tree: known.tree, file, command: known.command });
    const missing = files.filter((file) => mainRedStatus(known.receipts, at(file)).status === 'missing');
    if (!missing.length) {
      return { main: options.commit, files: files.map((file) => ({ file, ...known.rows.get(file) })),
        receipts: files.map((file) => mainRedStatus(known.receipts, at(file)).receipt) };
    }
    if (db) {
      for (const file of missing) {
        const key = mainRedKey(known.tree, file, known.command);
        try {
          createJob(db, { id: mainTestJobId(key), kind: MAIN_TEST_JOB, base: known.tree, now: now() });
          writeStep(db, mainTestJobId(key), 'queued', at(file), { now: now() });
        } catch { /* A board that cannot take the job still measures the file below; the verdict never waits on it. */ }
      }
    }
    return measure(root, profile, onWait, output, options);
  };
}

/** A commit's first parent and subject in `root`, or null when it cannot be read. */
function parentAndSubject(root, commit) {
  const result = gitSpawnSync(['--no-replace-objects', 'log', '-1', '--format=%P%x00%s', commit, '--'], { cwd: root });
  if (result.status !== 0) return null;
  const [parents, subject = ''] = String(result.stdout).trim().split('\0');
  const parent = parents.split(' ')[0];
  return /^[0-9a-f]{40,64}$/u.test(parent ?? '') ? { parent, subject } : null;
}

/**
 * The landing that first turned one test file red on main: a red result recorded at a main commit whose first parent
 * holds a green result for the same file, so exactly one landing lies between them [#5809]. Null when the record holds
 * no such green-then-red pair. Why: a red keyed only by digest never traced to the landing that broke main (u80 study).
 *
 * @param {string} root
 * @param {string} file - repository-relative test file
 * @param {{ cache?: { entries: object } }} [options] - a cache already read, else main's comparison cache
 * @returns {{ file: string, landing: string, item: number | null, subject: string,
 *   green: { main: string, at: string | null }, red: { main: string, at: string | null } } | null}
 */
export function firstRedLanding(root, file, { cache } = {}) {
  const entries = (cache ?? readCache(cacheFile(root))).entries ?? {};
  const results = new Map();
  for (const [commit, files] of Object.entries(entries)) {
    if (/^[0-9a-f]{40}$/u.test(commit) && ['red', 'green'].includes(files?.[file]?.result)) results.set(commit, files[file]);
  }
  const found = [];
  for (const [commit, result] of results) {
    if (result.result !== 'red') continue;
    const step = parentAndSubject(root, commit);
    if (!step || results.get(step.parent)?.result !== 'green') continue;
    const item = /^Merge #(\d+) onto /u.exec(step.subject);
    found.push({ file, landing: commit, item: item ? Number(item[1]) : null, subject: step.subject,
      green: { main: step.parent, at: results.get(step.parent).at ?? null }, red: { main: commit, at: result.at ?? null } });
  }
  // Several breaks of one file (red, fixed, red again): the earliest recorded red is the first one.
  return found.sort((a, b) => (a.red.at ?? '\uffff').localeCompare(b.red.at ?? '\uffff'))[0] ?? null;
}

/**
 * The verdict step of one item's gate verdict job (#3534), or null when the board holds none [C7,#3685].
 * Why the id is spelled here: it is gate's gateVerdictJobId ('gate-verdict:<item>:<candidate>'), kept local so landing
 * adds no cross-cell edge; apps/cli/journeys/verify/landing/verdict.test.js reads a real submit's verdict through it.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync }} board
 * @param {number} item
 * @param {string} candidate - the submitted commit
 * @returns {object | null}
 */
export function gateVerdictOf(board, item, candidate) {
  try { return jobView(board.db, `gate-verdict:${item}:${candidate}`)?.steps.findLast(step => step.name === 'verdict')?.payload ?? null; } catch { return null; }
}
