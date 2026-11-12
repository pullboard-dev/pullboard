/**
 * Main-test jobs on the pull queue [C7,P7]: the gate, submit and landing enqueue a `main-test` job (main's tree, one
 * test file, the test command) when main's receipt for that file is missing. The board offers each queued one to the
 * runner queue as a plain argv job at the main commit holding that tree, so `pullboard runner serve` claims it like any
 * other, and applies its receipt as the keyed main receipt the gate's main-red verdict reads.
 *
 * Why here: main-test was a controller-dispatch kind; under pull nothing ran it and every row stayed queued (#6063).
 */
import { tryGit } from '../../../git/index.js';
import { atomically } from '../../../jobs/index.js';
import { finishJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { pinQueuedJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';

/** The job kind the receipt cell's MAIN_TEST_JOB names; spelled here so the board API adds no edge to it. */
export const MAIN_TEST_KIND = 'main-test';
/** The line the job's entry prints last: whether the file passed on main, and its failing cases. */
const MAIN_TEST_LINE = 'PULLBOARD_MAIN_TEST ';
/** What a runner needs to take a main-test job: the gate's own Node. */
const NEEDS = ['node22'];
// Budget: one claim offers at most this many queued main-test rows, so a claim stays a small write.
const OFFER_ROWS = 50;
// Budget: a queued tree is looked for among trunk's last this-many first-parent commits; an older main is not re-checked.
const SCAN_COMMITS = 2000;
// Budget: the most failing case names one receipt line carries, each clipped, so the line fits the runner's 4 KiB tail.
const CASES = 20;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const RELATIVE_FILE = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r\\]{1,1024}$/u;

/** The main-comparison cache writer this process provides; null until a host provides one. */
let recorder = null;

/**
 * Provide the writer that puts a finished main-test job's verdict in the main comparison cache submit, landing and
 * serve read; null removes it. Why a provider: the landing cell owns that cache, and `pullboard serve` calls this once
 * at start, so the board API stays free of that cell [P7].
 * @param {((root: string, receipt: { main: string, file: string, verdict: 'green' | 'red', job: string, at: number }) => unknown) | null} write
 */
export function provideMainTestRecorder(write) {
  recorder = typeof write === 'function' ? write : null;
}

/**
 * The job's entry, run with Node in the main checkout: the test command on the one file, then one line naming its
 * verdict and failing cases, read with main's own TAP reader when main has one. Why main's reader: the checkout is
 * main itself, so its reader is the one main's gate trusts.
 */
const ENTRY = `import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [command, file] = process.argv.slice(1);
const env = { ...process.env, PULLBOARD_PULLED_JOB: '1' };
delete env.NODE_TEST_CONTEXT;
const ran = spawnSync(command + " '" + ('./' + file).replaceAll("'", "'\\\\''") + "'", { shell: true, env, encoding: 'utf8', maxBuffer: 256 * 1024 ** 2 });
const text = (ran.stdout ?? '') + (ran.stderr ?? '') + (ran.error ? String(ran.error.message) : '');
let failing = ran.status === 0 ? [] : null;
if (ran.status !== 0) {
  try {
    const light = await import(pathToFileURL(join(process.cwd(), 'packages', 'gate', 'light.js')).href);
    const rows = light.tapFailures(text, process.cwd());
    if (Array.isArray(rows) && rows.length && rows.length <= ${CASES}) failing = [...new Set(rows.map(row => String(row.name).slice(0, 120)))];
  } catch { failing = null; }
}
process.stdout.write(text.slice(-1500) + '\\n${MAIN_TEST_LINE}' + JSON.stringify({ green: ran.status === 0, status: ran.status, failing }) + '\\n');
process.exitCode = ran.status === 0 ? 0 : 1;
`;

/** The queued step's { tree, file, command }, or null when it cannot key a receipt. */
function queuedAt(view) {
  const at = view?.steps.find(step => step.name === 'queued')?.payload;
  return at && /^[0-9a-f]{40,64}$/u.test(at.tree ?? '') && RELATIVE_FILE.test(at.file ?? '') && typeof at.command === 'string' && at.command.trim() ? at : null;
}

/** Trunk's recent first-parent commits by tree id, read once from the board host's checkout. */
function commitsByTree(root) {
  const read = root ? tryGit(root, ['--no-replace-objects', 'log', '--first-parent', `-n${SCAN_COMMITS}`, '--format=%T %H', 'HEAD']) : { status: 1, stdout: '' };
  const trees = new Map();
  if (read.status !== 0) return trees;
  for (const line of read.stdout.split('\n')) {
    const [tree, commit] = line.split(' ');
    if (SHA.test(commit ?? '') && !trees.has(tree)) trees.set(tree, commit);
  }
  return trees;
}

/**
 * Offer every queued main-test job to the runner queue: name the main commit holding its tree as its candidate and
 * base, and write its offered step with the argv a runner runs there. A job whose tree is not on trunk's recent first
 * parents, or whose queued step keys nothing, is marked unoffered with why, so no claim reads it again.
 *
 * @param {any} board - The open board, gitRoot set to the board host's repository.
 * @param {{ now?: number }} [options]
 * @returns {string[]} the jobs offered now
 */
export function offerMainTests(board, { now = Date.now() } = {}) {
  const { db } = board;
  const rows = db.prepare("SELECT job_id FROM job WHERE job_kind = ? AND job_step = 'queued' ORDER BY job_created, job_id LIMIT ?").all(MAIN_TEST_KIND, OFFER_ROWS);
  if (!rows.length) return [];
  let trees = null;
  const offered = [];
  for (const { job_id: id } of rows) {
    const at = queuedAt(jobView(db, id));
    trees ??= at ? commitsByTree(board.gitRoot) : null;
    const commit = at ? trees.get(at.tree) : null;
    if (!commit) {
      writeStep(db, id, 'unoffered', { reason: at ? `main tree ${at.tree.slice(0, 12)} is not among trunk's last ${SCAN_COMMITS} commits` : 'the queued step names no tree, file and command' }, { now });
      continue;
    }
    const pinned = atomically(db, () => pinQueuedJob(db, id, commit, { now })
      && writeStep(db, id, 'offered', { needs: NEEDS, run: ['node', '--input-type=module', '-e', ENTRY, at.command, at.file] }, { now }).written);
    if (pinned) offered.push(id);
  }
  return offered;
}

/**
 * Apply a main-test job's posted receipt: write the keyed main receipt `{ id, tree, file, command, verdict, failing,
 * main, at }` as the job's receipt step 0, which the gate's main-red verdict reads (returnedMainReceipts). A receipt
 * whose run printed no verdict line stays recorded and keys nothing. Runner attempts post at seq 1 and up, so the
 * keyed receipt never collides with one.
 *
 * @param {any} board
 * @param {{ job: string, receipt: Record<string, any> }} posted
 * @param {{ now?: number }} [options]
 * @returns {{ applied: boolean, outcome: string, verdict?: 'green' | 'red' }}
 */
export function applyMainTestReceipt(board, { job, receipt }, { now = Date.now() } = {}) {
  const { db } = board;
  const at = queuedAt(jobView(db, job));
  const line = String(receipt?.tail ?? '').split('\n').findLast(row => row.startsWith(MAIN_TEST_LINE));
  let ran = null;
  try { ran = line ? JSON.parse(line.slice(MAIN_TEST_LINE.length)) : null; } catch { ran = null; }
  if (!at || typeof ran?.green !== 'boolean') return { applied: false, outcome: 'unread' };
  const failing = ran.green ? [] : Array.isArray(ran.failing) ? ran.failing.filter(name => typeof name === 'string') : [];
  const verdict = ran.green ? 'green' : 'red';
  atomically(db, () => {
    writeStep(db, job, 'receipt', { id: job, tree: at.tree, file: at.file, command: at.command, verdict, failing, main: receipt.commit ?? null, at: now }, { seq: 0, now });
    // The receipt step above moved the job's step; it stays finished.
    finishJob(db, job, null, { now });
  });
  // The cache is a convenience copy of the receipt above: a writer that fails leaves the receipt recorded.
  try { if (receipt.commit) recorder?.(board.gitRoot, { main: receipt.commit, file: at.file, verdict, job, at: now }); } catch { /* re-measured later */ }
  return { applied: true, outcome: 'recorded', verdict };
}
