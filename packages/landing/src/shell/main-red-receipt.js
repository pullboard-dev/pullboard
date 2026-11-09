/**
 * The landing's main-red lookup [C7,#3424]: whether a failing file is red on base main is read from main's receipt,
 * keyed by (main tree, file, test command). A file whose receipt is missing enqueues one main-test job on the board and
 * is measured through the measuring port, which writes the receipt; a file with a receipt is never run again.
 */
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { mainRedKey } from '../../../receipt/index.js';
import { mainRedStatus } from '../../../receipt/index.js';
import { MAIN_TEST_JOB } from '../../../receipt/index.js';
import { mainTestJobId } from '../../../receipt/index.js';
import { gitSpawnSync } from '../../../git/index.js';
import { policyAt } from '../../../sandbox/index.js';
import { cachedMainComparison } from './main-red.js';
import { compareMainFailures } from './main-red.js';

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
      failing: (row.failures ?? []).map((main) => main.name) });
    rows.set(row.file, row);
  }
  return { tree, command, receipts, rows };
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

/**
 * The verdict step of one item's gate verdict job (#3534), or null when the board holds none [C7,#3685].
 * Why the id is spelled here: it is gate's gateVerdictJobId ('gate-verdict:<item>:<candidate>'), kept local so landing
 * adds no cross-cell edge; test/landing-main-owned-verdict.test.js reads a real submit's verdict through it.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync }} board
 * @param {number} item
 * @param {string} candidate - the submitted commit
 * @returns {object | null}
 */
export function gateVerdictOf(board, item, candidate) {
  try { return jobView(board.db, `gate-verdict:${item}:${candidate}`)?.steps.findLast(step => step.name === 'verdict')?.payload ?? null; } catch { return null; }
}
