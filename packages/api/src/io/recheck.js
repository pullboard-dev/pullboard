/**
 * Main-test jobs on the pull queue [C7,P7]: the gate, submit and landing enqueue a `main-test` job (main's tree, one
 * test file, the test command) when main's receipt for that file is missing. The board offers each queued one to the
 * runner queue as a plain argv job at the main commit holding that tree, so `pullboard runner serve` claims it like any
 * other, and applies its receipt as the keyed main receipt the gate's main-red verdict reads.
 *
 * Why here: main-test was a controller-dispatch kind; under pull nothing ran it and every row stayed queued (#6063).
 */
import { tryGit } from '../../../git/index.js';
import { plainTrunkRef } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';
import { resolveCommit } from '../../../git/index.js';
import { trunkRevisionReader } from '../../../git/index.js';
import { atomically } from '../../../jobs/index.js';
import { createJob } from '../../../jobs/index.js';
import { readPayload } from '../../../jobs/index.js';
import { finishJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { pinQueuedJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { FAILURE_DIAGNOSTICS_SOURCE } from '../../../kernel/index.js';
import { CONFIG_FILE } from '../../../kernel/browser.js';

/** The job kind the receipt cell's MAIN_TEST_JOB names; spelled here so the board API adds no edge to it. */
export const MAIN_TEST_KIND = 'main-test';
/** The line the job's entry prints last: whether the file passed on main, and its failing cases. */
const MAIN_TEST_LINE = 'PULLBOARD_MAIN_TEST ';
/** The test runner's per-file cache frame, which names each file's input key; spelled here so the board API adds no edge to the gate cell. */
const INPUT_FRAME = '# pullboard test cache ';
/** What a runner needs to take a main-test job: the gate's own Node. */
const NEEDS = ['node22'];
// Budget: one claim offers at most this many queued main-test rows, so a claim stays a small write.
const OFFER_ROWS = 50;
// Budget: a queued tree is looked for among trunk's last this-many first-parent commits; an older main is not re-checked.
const SCAN_COMMITS = 2000;
// Budget: the most failing case names one receipt line carries, each clipped, so the line fits the runner's 4 KiB tail.
const CASES = 20;
/** The most UTF-16 units of one case name a main-test receipt keeps; the gate compares a longer case by this prefix. */
export const MAIN_CASE_NAME_UNITS = 120;
// Budget: a file is seeded when its failures appeared in the gates of at least this many distinct items.
const WIDE_ITEMS = 10;
// Budget: the failures counted are those of gates created in this window (24 h).
const WIDE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Budget: one seeding reads at most this many red gate and shard jobs, newest first, so it stays a small write.
const WIDE_SCAN_JOBS = 6000;
// Budget: one seeding queues at most this many files.
const WIDE_FILES = 50;
/** The seeding query: the 24 h window is the job_kind_created range, so it reads only the window's jobs, then one receipt step each by the job_step key. */
export const WIDE_SEED_SQL = `SELECT job.job_item AS item, step.job_step_payload AS payload FROM job
  JOIN job_step AS step ON step.job_step_job = job.job_id AND step.job_step_name = 'receipt'
    AND step.job_step_seq = (SELECT MAX(job_step_seq) FROM job_step WHERE job_step_job = job.job_id AND job_step_name = 'receipt')
  WHERE job.job_kind IN ('gate', 'gate-shard') AND job.job_item IS NOT NULL AND job.job_created >= ?
    AND COALESCE(json_extract(step.job_step_payload, '$.receipt.status'), 1) <> 0
  ORDER BY job.job_created DESC LIMIT ?`;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const RELATIVE_FILE = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r\\]{1,1024}$/u;

/** The main-comparison cache writer this process provides; null until a host provides one. */
let recorder = null;

/**
 * Provide the writer that puts a finished main-test job's verdict in the main comparison cache submit, landing and
 * serve read; null removes it. Why a provider: the landing cell owns that cache, and `pullboard serve` calls this once
 * at start, so the board API stays free of that cell [P7].
 * @param {((root: string, receipt: { main: string, file: string, verdict: 'green' | 'red', job: string, at: number, inputKey?: string }) => unknown) | null} write
 */
export function provideMainTestRecorder(write) {
  recorder = typeof write === 'function' ? write : null;
}

/**
 * The job's entry, run with Node in the main checkout: the test command on the one file, then one line naming its
 * verdict and failing cases, read with main's own TAP reader when main has one. Why main's reader: the checkout is
 * main itself, so its reader is the one main's gate trusts.
 */
/** The job's entry source, exported so a unit can run it against a fixture command. */
export const MAIN_TEST_ENTRY = `import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
${FAILURE_DIAGNOSTICS_SOURCE}
const [command, file] = process.argv.slice(1);
const env = { ...process.env, PULLBOARD_PULLED_JOB: '1' };
delete env.NODE_TEST_CONTEXT;
const ran = spawnSync(command + " '" + ('./' + file).replaceAll("'", "'\\\\''") + "'", { shell: true, env, encoding: 'utf8', maxBuffer: 256 * 1024 ** 2 });
const text = (ran.stdout ?? '') + (ran.stderr ?? '') + (ran.error ? String(ran.error.message) : '');
let failing = ran.status === 0 ? [] : null, signatures = ran.status === 0 ? [] : null;
if (ran.status !== 0) {
  let rows = null;
  try {
    // The run's own outcome frames carry its id; without it the reader refuses every run that printed them, so no case was ever named.
    let outcomeRunId = null;
    try { outcomeRunId = JSON.parse(text.split('\\n').find(line => line.startsWith('# pullboard test outcomes ')).slice('# pullboard test outcomes '.length)).id ?? null; } catch { outcomeRunId = null; }
    // The runner prints its own suite timing frame after TAP's final count, which the strict reader refuses as a trailer; the gate
    // reads the run through its timing strip, so this does too, binding the frame to the source it names itself [C7].
    let reading = text;
    try {
      const frame = text.split('\\n').find(line => line.startsWith('# pullboard suite timing '));
      const bound = frame ? JSON.parse(frame.slice('# pullboard suite timing '.length)) : null;
      if (bound?.id) reading = (await import(pathToFileURL(join(process.cwd(), 'packages', 'gate', 'index.js')).href)).timingAccountingOutput(text, bound.id, { head: bound.head, tree: bound.tree });
    } catch { reading = text; }
    rows = (await import(pathToFileURL(join(process.cwd(), 'packages', 'gate', 'light.js')).href)).tapFailures(reading, process.cwd(), { outcomeRunId, nativeLeaves: outcomeRunId !== null });
  }
  catch {
    // A project without Pullboard's TAP reader on main: its plain TAP 'not ok' case lines, never a file-level wrapper,
    // so a main red is named by case and a pulled gate can judge it main-owned [V4,B3,C7].
    rows = text.split('\\n').map(line => /^ *not ok [0-9]+ - (.+)$/u.exec(line)?.[1]?.split(' # ')[0].trim())
      .filter(name => name && !name.startsWith('/') && !/[.][cm]?js$/u.test(name)).map(name => ({ name }));
  }
  try {
    if (Array.isArray(rows) && rows.length && rows.length <= ${CASES}) {
      // Each case's diagnostic signature, as the controller signs it; a name clipped onto another with a different one keeps none [V4,B3].
      let signed = [];
      try { signed = caseSignatures(rows.map(row => ({ name: String(row.name) })), tapFailureDiagnostics(text, process.cwd(), value => createHash('sha256').update(value).digest('hex'))); } catch { signed = []; }
      const named = new Map();
      rows.forEach((row, index) => {
        const name = String(row.name).slice(0, ${MAIN_CASE_NAME_UNITS}), signature = signed[index] ?? null;
        named.set(name, named.has(name) && named.get(name) !== signature ? null : signature);
      });
      failing = [...named.keys()];
      signatures = [...named.values()];
    }
  } catch { failing = null; signatures = null; }
}
// The run's own cache frame names the file's test input key (the file, its import closure and declared inputs), so a gate on
// another main whose inputs to this file are the same reads this receipt [C7,SC11].
let inputKey = null;
for (const line of text.split('\\n')) {
  if (!line.startsWith('${INPUT_FRAME}')) continue;
  try { const row = JSON.parse(line.slice(${INPUT_FRAME.length})); if (row?.file === file && /^[0-9a-f]{64}$/u.test(row.inputKey ?? '')) inputKey = row.inputKey; } catch { /* A torn frame names no key. */ }
}
// The verdict line ends the output and fits the runner's 4 KiB tail whole; the run's own text takes what room is left.
const verdict = '${MAIN_TEST_LINE}' + JSON.stringify({ green: ran.status === 0, status: ran.status, failing, signatures, inputKey });
process.stdout.write(text.slice(-Math.max(0, Math.min(1500, 3900 - verdict.length))) + '\\n' + verdict + '\\n');
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
      && writeStep(db, id, 'offered', { priority: 'background', needs: NEEDS, run: ['node', '--input-type=module', '-e', MAIN_TEST_ENTRY, at.command, at.file] }, { now }).written);
    if (pinned) offered.push(id);
  }
  return offered;
}

/**
 * Apply a main-test job's posted receipt: write the keyed main receipt `{ id, tree, file, command, verdict, failing,
 * signatures, main, at }` as the job's receipt step 0, which the gate's main-red verdict reads (returnedMainReceipts). A receipt
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
  // A red whose cases could not be read keys nothing: a receipt naming none would excuse no case and bounce the builder for main's own red [C7].
  if (!ran.green && !(Array.isArray(ran.failing) && ran.failing.length)) return { applied: false, outcome: 'unnamed' };
  const named = ran.green || !Array.isArray(ran.failing) ? [] : ran.failing.map((name, index) => ({ name, signature: ran.signatures?.[index] })).filter(row => typeof row.name === 'string');
  const failing = named.map(row => row.name);
  // A case's diagnostic signature rides beside its name; one the run could not sign is null and never matches a gate's case [V4,B3].
  const signatures = named.map(row => typeof row.signature === 'string' && /^[0-9a-f]{64}$/u.test(row.signature) ? row.signature : null);
  const verdict = ran.green ? 'green' : 'red';
  // The file's test input key at that main, when the run printed one: the cache also keys the receipt by it [C7,SC11].
  const inputKey = /^[0-9a-f]{64}$/u.test(ran.inputKey ?? '') ? ran.inputKey : null;
  atomically(db, () => {
    writeStep(db, job, 'receipt', { id: job, tree: at.tree, file: at.file, command: at.command, verdict, failing, signatures, main: receipt.commit ?? null, at: now, ...(inputKey ? { inputKey } : {}) }, { seq: 0, now });
    // The receipt step above moved the job's step; it stays finished.
    finishJob(db, job, null, { now });
  });
  // The cache is a convenience copy of the receipt above: a writer that fails leaves the receipt recorded.
  try { if (receipt.commit) recorder?.(board.gitRoot, { main: receipt.commit, file: at.file, verdict, job, at: now, ...(inputKey ? { inputKey } : {}) }); } catch { /* re-measured later */ }
  return { applied: true, outcome: 'recorded', verdict };
}

/** The main each board root's wide failures were last seeded for; keyed by root path, never by db handle, so every open of one board root shares it. */
const seededAt = new Map();

/** The test files a posted gate or shard receipt names as failed: its red phases' failing cases and failed-file footers. */
function redFiles(receipt) {
  const files = new Set();
  for (const phase of Array.isArray(receipt?.gate?.phases) ? receipt.gate.phases : []) {
    if (phase?.status === 0) continue;
    for (const row of Array.isArray(phase?.failures) ? phase.failures : []) if (typeof row?.file === 'string') files.add(row.file);
    for (const file of Array.isArray(phase?.failedFiles) ? phase.failedFiles : []) if (typeof file === 'string') files.add(file);
  }
  return files;
}

/**
 * When accepted main advances, queue one main-test row (the row shape a gate's lookup queues) for each test file whose
 * failures appeared in the gates of WIDE_ITEMS or more distinct items in the last 24 h and that has no main-test job at
 * main's tree yet, so a gate red only there finds main's receipt coming instead of an unknown [C7,P7,#12035].
 * Why: nothing queued these ahead of the gates, so every wide-failing file cost each item a red or unknown first.
 * Nothing about the comparison loosens: a case is main-owned only on the same name and diagnostic signature.
 *
 * @param {any} board - The open board, gitRoot set to the board host's repository.
 * @param {{ main: string | null, now?: number }} options - main: accepted main's commit; the same main seeds once.
 * @returns {string[]} the main-test jobs queued now
 */
export function seedWideMainTests(board, { main, now = Date.now() }) {
  const { db } = board;
  if (!board.gitRoot || !SHA.test(String(main)) || seededAt.get(board.gitRoot) === main) return [];
  seededAt.set(board.gitRoot, main);
  const tree = tryGit(board.gitRoot, ['rev-parse', `${main}^{tree}`]);
  const shown = tryGit(board.gitRoot, ['show', `${main}:${CONFIG_FILE}`]);
  let command = null;
  try { command = shown.status === 0 ? JSON.parse(shown.stdout)?.affectedTests : null; } catch { command = null; }
  if (tree.status !== 0 || !/^[0-9a-f]{40,64}$/u.test(tree.stdout) || typeof command !== 'string' || !command.trim()) return [];
  // Red gates and shards of the window: an inline receipt that passed is skipped in SQL; a blob stub has no status and is read.
  const rows = db.prepare(WIDE_SEED_SQL).all(now - WIDE_WINDOW_MS, WIDE_SCAN_JOBS);
  const items = new Map();
  for (const { item, payload } of rows) {
    let posted = null;
    try { posted = readPayload(db, payload)?.receipt; } catch { posted = null; }
    for (const file of redFiles(posted)) {
      if (!RELATIVE_FILE.test(file)) continue;
      if (!items.has(file)) items.set(file, new Set());
      items.get(file).add(item);
    }
  }
  const queued = [];
  const wide = [...items].filter(([, who]) => who.size >= WIDE_ITEMS).sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1)).slice(0, WIDE_FILES);
  for (const [file] of wide) {
    const id = `${MAIN_TEST_KIND}:${tree.stdout}:${file}:${command}`;
    // Any main-test job at this tree and file, queued, offered or answered, already stands for it.
    if (db.prepare('SELECT 1 FROM job WHERE job_id = ?').get(id)) continue;
    atomically(db, () => {
      createJob(db, { id, kind: MAIN_TEST_KIND, base: tree.stdout, now });
      writeStep(db, id, 'queued', { tree: tree.stdout, file, command }, { now });
    });
    queued.push(id);
  }
  return queued;
}

/** The trunk ref reader of each board root, so a claim asks Git for the repository's paths once, not on every claim. */
const TRUNK_READERS = new Map();

/** Accepted main's commit, read from trunk's ref files first and from Git when they name none; null without a repository. */
function acceptedMain(root) {
  if (!root) return null;
  let reader = TRUNK_READERS.get(root);
  if (!reader) {
    reader = trunkRevisionReader(repoInfo(root));
    TRUNK_READERS.set(root, reader);
    while (TRUNK_READERS.size > 32) TRUNK_READERS.delete(TRUNK_READERS.keys().next().value);
  }
  const read = reader();
  return SHA.test(String(read)) ? read : resolveCommit(root, plainTrunkRef(root));
}

/** The claim path's seeding: wide failures for accepted main, once per board root and main sha; a refusal never fails the claim. */
export function seedWideMainTestsAtMain(board, { now }) {
  try { return seedWideMainTests(board, { main: acceptedMain(board.gitRoot), now }); } catch (error) { if (!error?.code) throw error; return []; }
}
