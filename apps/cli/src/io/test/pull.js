/**
 * `pullboard test` by pull: a test run
 * is one runner job row. This host pins the committed source as a git ref, offers the job and waits on its row; a
 * runner fetches the commit from the trunk remote and runs the files. Nothing here packs code or opens ssh [P7].
 *
 * It is the gate job's machinery with a smaller entry: the same bootstrap archives accepted main on the runner and runs
 * this entry from it, and the runner posts the entry's receipt line, as it does a gate's.
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { Refused } from '../../../../../packages/kernel/light.js';
import { FILE_TIME_LINE } from '../../../../../packages/gate/heavy.js';
import { testFileLoadScale } from '../../../../../packages/gate/heavy.js';
import { allTestOutcomes } from '../../../../../packages/gate/heavy.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { testLoadRerunEnabled } from '../../../../../packages/config/index.js';
import { gateRunnerWaitMs } from '../../../../../packages/config/index.js';
import { git } from '../../../../../packages/git/index.js';
import { headCommit } from '../../../../../packages/git/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { writeStep } from '../../../../../packages/jobs/index.js';
import { PULLED } from '../../../../../packages/drive/index.js';
import { JOB_ENV_NAME } from '../../../../../packages/drive/index.js';
import { boardRunsHolder } from '../../../../../packages/store/index.js';
import { ledgerHits } from '../../../../../packages/store/index.js';
import { recordTestResults } from '../../../../../packages/store/index.js';
import { withBoard } from '../context.js';
import { withBoardRead } from '../context.js';
import { fileBudgetField } from './file-limit.js';
import { fileLimitEnv } from './file-limit.js';

// The run-tests ledger variable (packages/gate LEDGER_HITS_ENV), named here because the gate's heavy door does not export it.
const LEDGER_HITS_ENV = 'PULLBOARD_LEDGER_HITS';

/** The job kind of a pulled test run; the board records its receipt and applies nothing, since the caller reads it. */
export const TEST_JOB_KIND = 'test';
// Budget: the waiting command reads its job row once a second, one small local read.
const POLL_MS = 1_000;
// Budget: the seat's claim is kept alive every 30 s while it waits, well inside the 2-minute liveness window.
const BEAT_MS = 30_000;
// Budget: the most failing cases a receipt names; the rest are in the output it carries.
const CASES = 100;

/**
 * The test job's entry, written into accepted main's archive by the gate bootstrap: it runs the named files with the
 * candidate's own focused runner in the candidate checkout and prints one receipt line with the run's output tail and
 * its failing cases, read by main's TAP reader. Why main's reader: it is the one the gate trusts to name cases.
 */
export const testJobEntry = (GATE_RECEIPT, PULLED_JOB_ENV, TIMING_RUN_ID_ENV, OUTCOME_PREFIX, DIAGNOSTICS) => `import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { freemem } from 'node:os';
import { loadavg } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
const tools = dirname(fileURLToPath(import.meta.url)), root = process.argv[2];
let light = null;
try { light = await import(pathToFileURL(join(tools, 'packages', 'gate', 'light.js')).href); } catch { /* an older main: a red run names no cases */ }
let gate = null;
try { gate = await import(pathToFileURL(join(tools, 'packages', 'gate', 'heavy.js')).href); } catch { /* an older main: the run records no ledger rows */ }
const input = JSON.parse(readFileSync(0, 'utf8'));
const started = performance.now();
// The job's own start time and the runner's 1-minute load at that moment, so a census row can place the job [C7,#9284].
const startedAt = new Date().toISOString(), loadAtStart = loadavg()[0];
// A runner job is nobody's subtest: a node:test context inherited from the runner's own host would skip every file.
// This runner is the job's whole execution host, so the run spreads its files over every core [P7,#5790].
// The job's main names the base the candidate's import graph forks from, so its key analysis parses only what changed [C7,#6672].
const env = { ...process.env, ${JSON.stringify(PULLED_JOB_ENV)}: '1', PULLBOARD_TEST_PRIOR: input.main };
delete env.NODE_TEST_CONTEXT;
// A job that names a file budget (pullboard test --no-file-limit) runs under it; any other job's limits are the runner's own [C7].
${fileLimitEnv.toString()}
Object.assign(env, fileLimitEnv(input));
// The board's ledger hits for this run's files: a file whose own key and context match a hit is reused, so an unchanged file does not run again [P7].
const hits = input.testResults?.ledger;
if (hits && Array.isArray(hits.files)) { const hitsFile = join(tools, 'pullboard-ledger-hits.json'); writeFileSync(hitsFile, JSON.stringify({ ...hits, account: true }), { mode: 0o600 }); env[${JSON.stringify(LEDGER_HITS_ENV)}] = hitsFile; }
// A review comparison names its run id, so the test runner frames each case's outcome under it [V4,C7].
const runId = typeof input.runId === 'string' && /^[a-f0-9-]{36}$/u.test(input.runId) ? input.runId : null;
if (runId) env.${TIMING_RUN_ID_ENV} = runId;
const ran = spawnSync(input.command, { shell: true, cwd: root, env, maxBuffer: 256 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] });
const output = Buffer.concat([ran.stdout ?? Buffer.alloc(0), ran.stderr ?? Buffer.alloc(0)]);
const text = output.toString('utf8') + (ran.error ? String(ran.error.message) : '');
let failures = null, cases = null;
try {
  const rows = ran.status === 1 && light?.tapFailures ? light.tapFailures(text, root) : null;
  if (Array.isArray(rows) && rows.length && rows.length <= ${CASES} && rows.every(row => row?.file && row.name)) cases = rows.map(({ file, name }) => ({ file, name: String(name) }));
  failures = cases ? cases.map(row => ({ ...row, name: row.name.slice(0, 300) })) : null;
} catch { failures = null; cases = null; }
${DIAGNOSTICS}
// Each named case's diagnostic signature, as the gate job signs it, so a comparison tells two failures of one case apart [V4,C7].
let failureSignatures = null;
// Signed by the whole names, so a case the receipt clips still finds its own diagnostic (#7495).
try { failureSignatures = cases ? caseSignatures(cases, tapFailureDiagnostics(text, root, value => createHash('sha256').update(value).digest('hex'))) : null; } catch { failureSignatures = null; }
/** The run's case outcomes as [file, name, passed, skipped] rows from its frames under runId; null when none or malformed. */
const framed = () => {
  const rows = [];
  for (const row of text.split('\\n')) {
    if (!row.startsWith(${JSON.stringify(OUTCOME_PREFIX)})) continue;
    let frame;
    try { frame = JSON.parse(row.slice(${OUTCOME_PREFIX.length})); } catch { return null; }
    if (frame?.id !== runId) continue;
    if (frame.version !== 1 || !Array.isArray(frame.tests)) return null;
    for (const one of frame.tests) rows.push([one?.file, one?.name, one?.passed, one?.skipped]);
  }
  return rows.length ? rows : null;
};
const receipt = { version: 1, kind: 'test', main: input.main, source: input.source, files: input.files, steps: { test: Math.round(performance.now() - started) },
  environment: { node: process.versions.node, platform: process.platform, arch: process.arch }, green: ran.status === 0,
  // The runner's own load, so the board can keep main's side of a comparison as a native receipt [V4,C7].
  load: { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) }, startedAt, endedAt: new Date().toISOString(), loadAtStart,
  phases: [{ role: 'test', status: ran.status, signal: ran.signal, sha256: createHash('sha256').update(output).digest('hex'), bytes: output.length, tail: '', ...(ran.status !== 0 ? { failures, ...(failureSignatures ? { failureSignatures } : {}) } : {}) }] };
// Each file that ran under a key becomes a proof-ledger row the board records from this receipt, green files of a red run included [P7].
try { const ledger = typeof gate?.phaseLedger === 'function' ? gate.phaseLedger(text, { status: ran.status, failures, root, budget: 16000 }) : null; if (ledger) receipt.phases[0].ledger = ledger; } catch { /* no rows: the gate runs the files */ }
// The receipt line stays under the runner's receipt-line cap: the tail shrinks until the whole line fits.
if (runId) receipt.outcomes = framed();
/**
 * Each named file's verdict in a red run, read from the whole output before any tail is cut: a failing file lists its
 * first failing cases, a file the run finished while every failing case is placed in some named file is 'green'. Why: the
 * outcome frames are dropped whole when the receipt line is too long or a nested failure voids them, and the clipped
 * tail then proves no file, so a whole census shard read as no-result [C7,#7920].
 */
const verdicts = () => {
  if (ran.status === 0) return null;
  const bare = value => String(value).trim().replace(/^(['"])(.*)\\1$/u, '$2').replace(/:\\d+(?::\\d+)?$/u, '').replace(/^\\.\\//u, '');
  const named = input.files.map(bare);
  const fileOf = value => named.find(path => bare(value) === path || bare(value).endsWith('/' + path)) ?? null;
  const lines = text.split('\\n');
  const out = {};
  let unplaced = 0;
  for (let at = 0; at < lines.length; at += 1) {
    const row = /^(\\s*)not ok\\s+\\d+\\s+-\\s+(.*)$/u.exec(lines[at]);
    if (!row || /#\\s*(?:SKIP|TODO)\\b/iu.test(row[2])) continue;
    const name = row[2].replace(/\\s+#.*$/u, '');
    // The case's own location line places it first; its name, which may merely mention another file, only when there is none.
    let file = null, located = false;
    for (let next = at + 1; next < lines.length && !file && /^\\s/u.test(lines[next]) && !/^\\s*(?:not )?ok\\s/u.test(lines[next]); next += 1) {
      const location = /^\\s*location:\\s*(.*?)\\s*$/u.exec(lines[next]);
      if (location) { located = true; file = fileOf(location[1]); }
    }
    if (!located) file = fileOf(name);
    if (file) out[file] = [...new Set([...(out[file] ?? []), name.slice(0, 120)])].slice(0, 3); else unplaced += 1;
  }
  const finished = new Set(lines.filter(line => line.startsWith(${JSON.stringify(FILE_TIME_LINE)})).map(line => fileOf(line.slice(${FILE_TIME_LINE.length}).replace(/^\\S+ /u, ''))));
  const stopped = /run-tests: (?:HUNG|TIMEOUT) file/u.test(text);
  for (const file of named) {
    if (out[file]) continue;
    const mine = (receipt.outcomes ?? []).filter(row => fileOf(row[0]) === file);
    if (mine.length ? mine.every(row => row[2] === true) : !receipt.outcomes && unplaced === 0 && !stopped && finished.has(file)) out[file] = 'green';
  }
  return out;
};
try { receipt.verdicts = verdicts(); } catch { receipt.verdicts = null; }
// Each file's own wall ms from its time line, read from the whole output before the tail is cut, so a clipped receipt still times every file [C7,#8576].
try {
  const times = {};
  for (const row of text.split('\\n')) {
    if (!row.startsWith(${JSON.stringify(FILE_TIME_LINE)})) continue;
    const rest = row.slice(${FILE_TIME_LINE.length}), space = rest.indexOf(' '), ms = Number(rest.slice(0, space));
    if (space > 0 && Number.isFinite(ms) && ms >= 0) times[rest.slice(space + 1).trim()] = Math.max(times[rest.slice(space + 1).trim()] ?? 0, ms);
  }
  receipt.times = times;
} catch { receipt.times = null; }
// Each file's ms inside its top-level cases, read from the whole TAP before the tail is cut and placed by case name through the outcome rows, so the census can say how much of a file's wall is setup [C7,#9028].
try {
  const owners = new Map();
  for (const row of receipt.outcomes ?? []) owners.set(row[1], [...new Set([...(owners.get(row[1]) ?? []), row[0]])]);
  const caseMs = {}, rows = text.split('\\n');
  for (let at = 0; at < rows.length; at += 1) {
    const head = /^(?:not ok|ok)\\s+\\d+\\s+-\\s+(.*)$/u.exec(rows[at]);
    if (!head) continue;
    let ms = null;
    for (let next = at + 1; next < rows.length && /^\\s/u.test(rows[next]); next += 1) {
      if (/^\\s+(?:not ok|ok)\\s+\\d+\\s+-/u.test(rows[next])) break;
      const field = /^ {2}duration_ms:\\s*([\\d.]+)\\s*$/u.exec(rows[next]);
      if (field) { ms = Number(field[1]); break; }
    }
    const files = owners.get(head[1].replace(/\\s+#\\s*(?:SKIP|TODO)\\b.*$/iu, '')) ?? owners.get(head[1]);
    if (ms !== null && files && files.length) for (const file of files) caseMs[file] = (caseMs[file] ?? 0) + ms / files.length;
  }
  receipt.caseMs = receipt.outcomes ? caseMs : null;
} catch { receipt.caseMs = null; }
let keep = 40000, line;
do { receipt.phases[0].tail = text.slice(-keep); line = ${JSON.stringify(GATE_RECEIPT)} + JSON.stringify(receipt); keep = Math.floor(keep / 2); } while (Buffer.byteLength(line) > 56 * 1024 && keep > 0);
// Outcomes too many for the line are dropped whole, so the comparison reads them unavailable, never partial.
if (Buffer.byteLength(line) > 56 * 1024 && receipt.outcomes) { receipt.outcomes = null; receipt.phases[0].tail = text.slice(-4000); line = ${JSON.stringify(GATE_RECEIPT)} + JSON.stringify(receipt); }
process.stdout.write('\\n' + line + '\\n');
process.exitCode = receipt.green ? 0 : 1;
`;

/**
 * True when this test run is a runner job row: always, since every runner job is a row. `--affected` and `--diagnose` keep the existing path, since their
 * selection and full log are read on this machine.
 *
 * @param {number | undefined} item - The seat's sole claimed item.
 * @param {Record<string, any>} values - The parsed switches.
 */
export function pullTestWanted(item, values) {
  if (values.affected === true || values.diagnose === true) return false;
  return runnerDispatchMode() === 'pull';
}

/**
 * Refuse an uncommitted change before anything is offered: a runner fetches the committed source only, so a dirty
 * tree's edits would not be under test. The words are the notice the existing path prints [C7,#3733].
 *
 * @param {string} root
 */
export async function refuseUncommitted(root) {
  const { uncommittedNotice } = await import('../../../../../packages/gate/index.js');
  const notice = uncommittedNotice(root);
  if (notice) throw new Refused('TEST_UNCOMMITTED', notice);
}

/** Quote one argument for the configured focused test command, as the existing path does. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * The test results a finish run's job carries: an origin naming the run, and the board's ledger hits for the run's files
 * with the input keys they hold, so the runner reuses an unchanged file and the receipt's rows are posted for the ledger
 * [P7]. Null when the board holds no hit for the files.
 *
 * @param {string} run - The run id, or the job's tag when it has none.
 * @param {{ contexts: string[], files: Array<[string, string, number]> } | null} ledger
 */
export function finishTestResults(run, ledger) {
  if (!ledger || !Array.isArray(ledger.files) || !ledger.files.length) return null;
  return { origin: `finish:${run}`, inputKeys: [...new Set(ledger.files.map(row => row[1]))].sort(), ledger };
}

/**
 * The proof-ledger rows a finish run's receipt carries: one row per file its run phase ran under a key, recorded under
 * the gate's proof command so the gate's own offer finds them; none when the receipt holds no keyed file [P7].
 *
 * @param {Record<string, any>} gate - The receipt's gate section.
 * @returns {Array<{ file: string, inputKey: string, command: string, context: string, status: string }>}
 */
export function finishLedgerRows(gate) {
  const rows = [];
  for (const phase of Array.isArray(gate?.phases) ? gate.phases : []) {
    const { contexts, files } = phase?.ledger ?? {};
    if (!Array.isArray(contexts) || !Array.isArray(files)) continue;
    for (const [file, inputKey, context, status] of files.filter(Array.isArray)) rows.push({ file, inputKey, command: 'proof', context: contexts[context], status });
  }
  return rows;
}

/**
 * The data a test job carries into its entry. `fileBudgetMs` is the file budget the runner gives this job's files
 * (set by --no-file-limit); a job without it carries no such field and runs under the runner's own limits [C7].
 */
export function testJobData({ main, commit, command, files, runId = null, fileBudgetMs = null, testResults = null }) {
  return { main, source: commit, command, files, ...(runId ? { runId } : {}), ...(fileBudgetMs ? { fileBudgetMs } : {}), ...(testResults ? { testResults } : {}) };
}

/**
 * The caller's variables a runner will accept for a job: exactly the names JOB_ENV_NAME allows, so a fixture switch set
 * around pullboard test reaches the job and PATH, HOME or a loader option never does [C7,#10849].
 *
 * @param {Record<string, string | undefined>} environment
 * @returns {Record<string, string>}
 */
function testJobEnv(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) => JOB_ENV_NAME.test(name) && typeof value === 'string'));
}

/**
 * Pin a commit under refs/pullboard/test and name the one test job row for it, without writing the row.
 * Why a ref: the trunk remote serves only reachable commits, and an agent's commit is reachable from nothing else yet.
 */
export async function testJobRow(ctx, { item, commit, main, command, files, runId = null, fileBudgetMs = null, censusPerRunner = null, censusPerRunnerQuiet = null, ledger = null, environment = process.env }) {
  const { root } = ctx.info;
  const [{ GATE_NEEDS, GATE_RECEIPT, gateJobRun }, { PULLED_JOB_ENV, TIMING_RUN_ID_ENV, TEST_OUTCOMES_PREFIX }, { FAILURE_DIAGNOSTICS_SOURCE }] = await Promise.all([import('../submit/pull.js'),
    import('../../../../../packages/gate/index.js'), import('../../../../../packages/kernel/index.js')]);
  const tag = randomBytes(6).toString('hex');
  const ref = `refs/pullboard/test/${tag}`;
  git(root, ['update-ref', ref, commit]);
  const env = testJobEnv(environment);
  const request = { run: gateJobRun(), ...(Object.keys(env).length ? { env } : {}), input: { main, entry: testJobEntry(GATE_RECEIPT, PULLED_JOB_ENV, TIMING_RUN_ID_ENV, TEST_OUTCOMES_PREFIX, FAILURE_DIAGNOSTICS_SOURCE), data: testJobData({ main, commit, command, files, runId, fileBudgetMs, testResults: finishTestResults(runId ?? tag, ledger) }) }, commits: [main] };
  return { ref, row: { id: `test:${commit.slice(0, 12)}:${tag}`, kind: TEST_JOB_KIND, priority: 'interactive', needs: GATE_NEEDS,
    item: item === undefined ? null : Number(item), candidate: commit, base: main, request, ...(censusPerRunner ? { censusPerRunner } : {}), ...(censusPerRunner && censusPerRunnerQuiet ? { censusPerRunnerQuiet } : {}) } };
}

/** Start this machine's loopback runner when it has no registered one, as a pull submit does: otherwise the job waits unclaimed [P7,C7]. */
async function startLocalRunner(ctx) {
  const [{ primaryCheckoutRoot }, { ensureLocalRunner }] = await Promise.all([import('../worktree.js'), import('../runner/local.js')]);
  const host = primaryCheckoutRoot(ctx.info);
  if (host) await ensureLocalRunner(host);
}

/**
 * The holder of the board's runs handle while runs_store is on, else null: an interactive test job's rows live there and
 * nowhere on the board, since no move uses them [P7,B2,#9011]. The runs file opens on first use of `holder.db`.
 *
 * @param {object} ctx
 * @returns {{ readonly db: import('node:sqlite').DatabaseSync } | null}
 */
export function testRunsHolder(ctx) {
  return withBoardRead(ctx, board => boardRunsHolder(board, ctx.file));
}

/**
 * Offer a test job row to the store that holds it: the runs file when `runs` is given, else the board. With runs_store on
 * the job gets no board run row, because nothing on the board decides on it; off, it is the board job row as on main.
 *
 * @param {Function} offerJob - The api's offerJob.
 * @param {{ board?: { db: import('node:sqlite').DatabaseSync }, runs?: { db: import('node:sqlite').DatabaseSync } | null }} stores
 * @param {object} row
 */
export function offerTestRow(offerJob, { board, runs = null }, row) {
  return offerJob((runs ?? board).db, row);
}

/** A test job's view from the store that holds it: the runs file when `runs` is given, else the board. */
export function readTestRow({ board, runs = null }, job) {
  return jobView((runs ?? board).db, job);
}

/** Offer one test job for a commit. Returns the job id and the pinned ref. */
async function offerTestJob(ctx, fields, runs, onOffer) {
  const { offerJob } = await import('../../../../../packages/api/index.js');
  const ledger = Array.isArray(fields.files) && fields.files.length ? withBoardRead(ctx, board => ledgerHits(board.db, fields.files)) : null;
  const { ref, row } = await testJobRow(ctx, { ...fields, ledger });
  const job = runs ? offerTestRow(offerJob, { runs }, row) : withBoard(ctx, board => offerTestRow(offerJob, { board }, row));
  onOffer?.(job.id, runs);
  await startLocalRunner(ctx);
  return { job: job.id, ref };
}

/**
 * Queue an accept's frozen check as one runner job on the open board and return its id at once; the caller settles the
 * verdict from the job's receipt, so no waiting happens here. The commit stays pinned under the returned ref until then [C7,#3161].
 *
 * @param {object} ctx
 * @param {{ db: import('node:sqlite').DatabaseSync }} board - The board the verdict is being recorded on.
 * @param {{ item: number, commit: string, main: string, command: string }} fields - command: the item's frozen check.
 * @returns {Promise<{ job: string, ref: string }>}
 */
export async function offerAcceptCheck(ctx, board, { item, commit, main, command }) {
  const { offerJob } = await import('../../../../../packages/api/index.js');
  const { ref, row } = await testJobRow(ctx, { item, commit, main, command, files: [] });
  const job = offerJob(board.db, row);
  await startLocalRunner(ctx);
  return { job: job.id, ref };
}

/**
 * Wait on a job's row until a runner posts its receipt, keeping the seat alive. Refuses when no runner claims it within
 * gate.runnerWaitMs, as a runner-only test run waits today.
 *
 * @returns {Promise<{ receipt: Record<string, any>, runner: string | null, enqueuedAt: string | null }>}
 */
async function receiptOf(ctx, { job, agent, say, wait = pause, pollMs = POLL_MS, runs = null, signal }) {
  const deadline = Date.now() + gateRunnerWaitMs();
  let beat = 0, claimed = null;
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new Error('test job stopped');
    const view = runs ? readTestRow({ runs }, job) : withBoardRead(ctx, board => readTestRow({ board }, job));
    if (!view) throw new Refused('TEST_JOB_MISSING', `test job ${job} is gone from the board; run pullboard test again`);
    const posted = [...view.steps].reverse().find(step => step.name === 'receipt');
    if (posted) return { receipt: posted.payload.receipt ?? {}, runner: posted.payload.runner ?? null, enqueuedAt: Number.isFinite(view.created) ? new Date(view.created).toISOString() : null };
    const holder = view.leaseOwner && view.leaseUntil > Date.now() ? view.leaseOwner : null;
    if (holder && holder !== claimed) { claimed = holder; say?.(`pullboard test: runner ${holder} took test job ${job}`); }
    if (!claimed && Date.now() > deadline) {
      throw new Refused('TEST_JOB_UNCLAIMED', `no runner took test job ${job} within ${Math.round(gateRunnerWaitMs() / 1000)}s; start one with pullboard runner serve <board-url>, then run pullboard test again`);
    }
    if (agent && Date.now() - beat >= BEAT_MS) {
      beat = Date.now();
      const { heartbeatSeat } = await import('../../../../../packages/store/index.js');
      try { withBoard(ctx, board => heartbeatSeat(board, agent)); } catch (error) { if (!error?.code) throw error; }
    }
    try { await wait(pollMs, null, signal ? { signal } : undefined); } catch (error) { if (signal?.aborted) throw signal.reason ?? error; throw error; }
  }
}

/**
 * Run one test job to its receipt and drop its pin; the receipt's phase is the run. A queued run's worker (`testRun`)
 * names the job on its run, so the receipt still settles the run if the worker stops before it (#7574).
 */
async function runJobFor(ctx, fields, { agent, say, testRun, signal, onOffer }) {
  // The moment a runner took the job, for a census row's claimedAt [C7,#9284].
  let claimedAt = null;
  const noted = say;
  say = line => { if (claimedAt === null && /took test job/u.test(String(line))) claimedAt = new Date().toISOString(); noted?.(line); };
  const runs = testRunsHolder(ctx);
  const offered = await offerTestJob(ctx, fields, runs, onOffer);
  if (typeof testRun === 'string' && testRun) withBoard(ctx, board => writeStep((runs ?? board).db, testRun, PULLED, { job: offered.job, until: Date.now() + gateRunnerWaitMs() }));
  say?.(`pullboard test: offered test job ${offered.job} for ${fields.commit.slice(0, 12)}; a runner fetches it from the trunk remote and runs it`);
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('test job stopped');
    const { receipt, runner, enqueuedAt } = await receiptOf(ctx, { job: offered.job, agent, say, runs, signal });
    const gate = receipt.gate ?? {};
    const rows = finishLedgerRows(gate);
    if (rows.length) withBoard(ctx, board => recordTestResults(board.db, { receipt: `${offered.job}#0`, origin: `finish:${runner ?? 'unknown'}`, commit: fields.commit, rows }));
    const phase = gate.phases?.[0] ?? null;
    const green = receipt.status === 0 && gate.green === true && phase?.status === 0;
    const output = phase?.tail ?? gate.error ?? receipt.tail ?? '';
    const outcomes = Array.isArray(gate.outcomes) ? gate.outcomes.filter(Array.isArray).map(([file, name, passed, skipped]) => ({ file, name, passed, skipped })) : null;
    return { job: offered.job, runner, green, enqueuedAt, claimedAt, startedAt: typeof gate.startedAt === 'string' ? gate.startedAt : null, endedAt: typeof gate.endedAt === 'string' ? gate.endedAt : null, loadAtStart: Number.isFinite(gate.loadAtStart) ? gate.loadAtStart : null, load: gate.load && typeof gate.load === 'object' ? gate.load : null, output: String(output), failures: Array.isArray(phase?.failures) ? phase.failures : null,
      signatures: Array.isArray(phase?.failureSignatures) && phase.failureSignatures.length === phase?.failures?.length ? phase.failureSignatures : null, durationMs: receipt.durationMs ?? null, outcomes,
      verdicts: gate.verdicts && typeof gate.verdicts === 'object' && !Array.isArray(gate.verdicts) ? gate.verdicts : null,
      times: gate.times && typeof gate.times === 'object' && !Array.isArray(gate.times) ? gate.times : null,
      caseMs: gate.caseMs && typeof gate.caseMs === 'object' && !Array.isArray(gate.caseMs) ? gate.caseMs : null };
  } finally {
    onOffer?.(offered.job, runs, true);
    try { git(ctx.info.root, ['update-ref', '-d', offered.ref]); } catch { /* a pin left behind only keeps a commit reachable */ }
  }
}

/**
 * Run one test file at one commit as a pulled test job and answer whether it passed: `pullboard red bisect`'s probe.
 * Why a pulled job: a probe is any runner's work, offered as gate and test jobs are, never run on the board host [P7,C7,#7575].
 *
 * @param {object} ctx
 * @param {{ commit: string, file: string, say?: (line: string) => void }} probe
 * @returns {Promise<boolean>}
 */
export async function probeTestAt(ctx, { commit, file, say }) {
  const config = ctx.config;
  if (typeof config.affectedTests !== 'string' || !config.affectedTests.trim()) {
    throw new Refused('NO_TEST_RUNNER', 'set "affectedTests" in pullboard.json to the command that runs named test files, like "node apps/cli/src/io/run/tests.js"');
  }
  const { mainPolicy } = await import('../../../../../packages/sandbox/index.js');
  const main = mainPolicy(ctx.info.root).commit;
  if (!main) throw new Refused('TEST_SNAPSHOT', 'this checkout has no accepted main to probe against; run pullboard red bisect from the board\'s checkout');
  const ran = await runJobFor(ctx, { item: undefined, commit, main, command: `${config.affectedTests.trimEnd()} ${shellWord('./' + file)}`, files: [file] }, { say });
  return ran.green;
}

/**
 * Run one side of a review comparison as a pulled test job: the files at `commit` under the comparison command, with
 * each case's outcome framed under `runId`. Why a pulled job: the comparison ran over the SSH controller transport,
 * which a local pull runner never claims, so `verify --compare` and the background comparison stopped under pull [V4,C7].
 *
 * @param {object} ctx
 * @param {{ item: number, commit: string, main: string, command: string, files: string[], runId: string, say?: (line: string) => void, fileBudgetMs?: number | null }} fields
 * @returns {Promise<{ job: string, runner: string | null, green: boolean, output: string, outcomes: { file: string, name: string, passed: boolean, skipped: boolean }[] | null, verdicts: Record<string, 'green' | string[]> | null, times: Record<string, number> | null, caseMs: Record<string, number> | null }>}
 */
export async function runPulledComparison(ctx, { item, commit, main, command, files, runId, say, fileBudgetMs = null, censusPerRunner = null, censusPerRunnerQuiet = null, signal, onOffer }) {
  return runJobFor(ctx, { item, commit, main, command, files, runId, fileBudgetMs, censusPerRunner, censusPerRunnerQuiet }, { say, signal, onOffer });
}

/**
 * The named files a TAP run reports red, each mapped to whether one of its cases timed out or was cancelled, read from
 * the location (or the file-level name) of every failing row, whichever checkout the runner ran in. Why: a pulled run
 * whose cases name no file (a file Node stopped at its timeout) still says which files failed, so each gets a main
 * verdict per file [C7].
 *
 * @param {string} text - The run's output.
 * @param {string[]} paths - The repo paths the run named.
 * @returns {Map<string, boolean>}
 */
function redFilesIn(text, paths) {
  const red = new Map();
  const fileOf = value => {
    const seen = String(value ?? '').trim().replace(/^(['"])(.*)\1$/u, '$2').replace(/:\d+(?::\d+)?$/u, '').replace(/^\.\//u, '');
    return paths.find(path => seen === path || seen.endsWith(`/${path}`)) ?? null;
  };
  const note = active => { if (active?.file) red.set(active.file, Boolean(red.get(active.file) || active.stopped)); };
  let active = null;
  for (const line of String(text).split('\n')) {
    const row = /^(\s*)(not ok|ok)\s+\d+\s+-\s+(.*)$/u.exec(line);
    if (row) {
      active = row[2] === 'not ok' && !/#\s*(?:SKIP|TODO)\b/iu.test(row[3]) ? { indent: row[1].length, file: fileOf(row[3].replace(/\s+#.*$/u, '')), stopped: false } : null;
      note(active);
      continue;
    }
    const field = active && /^(\s*)(location|failureType):\s*(.*?)\s*$/u.exec(line);
    if (!field || field[1].length !== active.indent + 2) continue;
    if (field[2] === 'location') active.file = fileOf(field[3]) ?? active.file;
    else active.stopped ||= /testTimeoutFailure|cancelledByParent/u.test(field[3]);
    note(active);
  }
  return red;
}

/**
 * The board's main-red receipt for one main-side job, read from this checkout's receipt store; null when none is
 * there. Why the short wait: the board writes the receipt as it applies the post the job row already shows.
 */
async function boundReceipt(root, job, wait = pause) {
  const [{ mainRedReceiptId }, { readGateReceipt, receiptStore }] = await Promise.all([import('../../../../../packages/api/index.js'), import('../../../../../packages/gate/heavy.js')]);
  for (let tries = 0; ; tries += 1) {
    const receipt = readGateReceipt(receiptStore(root), mainRedReceiptId(job));
    if (receipt || tries >= 10) return receipt;
    await wait(200);
  }
}

/**
 * Compare a red run with main's, by one more test job at main per red file under main's accepted command: each red
 * file gets main's verdict (red, green, or absent at main), and each named case either also fails on main or fails
 * only with the change. A case that timed out or was cancelled is judged by its file alone, since a timeout names no
 * identical failure. Each judged file names the board's main-red receipt and main's signed failures, so the seat's
 * notice cites the receipt as the controller's comparison does [V4,B3,C7].
 */
async function compareWithMain(ctx, run, { main, runner, paths, agent, say }) {
  const candidate = redFilesIn(run.output, paths);
  for (const row of run.failures ?? []) if (paths.includes(row.file) && !candidate.has(row.file)) candidate.set(row.file, false);
  const files = [...candidate.keys()];
  if (!files.length) return { notices: [], known: [], unavailable: run.failures ? 'the failing cases are in files the run did not name' : 'the run\'s output does not name every failing case' };
  const absent = files.filter(file => { try { git(ctx.info.root, ['cat-file', '-e', `${main}:${file}`]); return false; } catch { return true; } });
  const present = files.filter(file => !absent.includes(file));
  say?.('pullboard test: waiting on the main comparison (--compare-main)');
  const [{ mainTestCommand }, { MAIN_FAILURE_SIGNATURE_VERSION }] = await Promise.all([import('../../../../../packages/api/index.js'), import('../../../../../packages/kernel/index.js')]);
  // One job per file, so each file's receipt binds the exact command main ran for it.
  const runs = new Map(await Promise.all(present.map(async file => [file, await runJobFor(ctx, { item: undefined, commit: main, main,
    command: mainTestCommand(runner, file), files: [file] }, { agent, say })])));
  const known = [];
  for (const file of files) {
    if (absent.includes(file)) { known.push({ file, job: null, result: 'absent' }); continue; }
    const onMain = runs.get(file);
    const red = redFilesIn(onMain.output ?? '', [file]).has(file) || (onMain.failures ?? []).some(row => row.file === file);
    // Main's verdict on a file is known when its run passed or names it failing; otherwise the file is not judged.
    if (!onMain.green && !red) continue;
    const rows = onMain.green ? [] : (onMain.failures ?? []).map((row, index) => ({ file: row.file, name: row.name, signature: onMain.signatures?.[index] ?? null }));
    const signed = onMain.green || onMain.failures && rows.every(row => row.signature);
    const receipt = signed ? await boundReceipt(ctx.info.root, onMain.job) : null;
    known.push({ file, job: onMain.job, result: onMain.green ? 'green' : 'red',
      ...(receipt ? { receiptId: receipt.id, failures: rows, signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION } : {}) });
  }
  const sides = [...runs.values()];
  if (!run.failures || sides.some(side => !side.green && !side.failures)) {
    const unnamed = present.filter(file => !runs.get(file).green && !runs.get(file).failures);
    return { notices: [], known, ...(known.length ? {} : { unavailable: !run.failures ? 'the run\'s output does not name every failing case' : `main's run of ${unnamed.join(', ')} names no failing cases` }) };
  }
  // Main's failing cases with each one's diagnostic signature, so one case red on both sides in different ways is not main's [V4,B3].
  const mainCases = new Map(sides.flatMap(side => (side.failures ?? []).map((row, index) => [`${row.file}\0${row.name}`, { signature: side.signatures?.[index] ?? null, job: side.job }])));
  const jobOf = file => runs.get(file)?.job ?? null;
  return { known, notices: run.failures.flatMap((row, index) => {
    if (!paths.includes(row.file) || candidate.get(row.file)) return [];
    const key = `${row.file}\0${row.name}`, mine = run.signatures?.[index] ?? null, theirs = mainCases.get(key)?.signature ?? null;
    // An unsigned case on either side is never matched by its name alone [V4,B3].
    const status = !mainCases.has(key) ? 'candidate-only' : mine && theirs && mine === theirs ? 'also-main' : 'different-on-main';
    return [{ status, main, file: row.file, name: row.name,
      message: status === 'also-main' ? `also fails on main at ${main}: ${row.file} :: ${row.name} (not yours; test job ${jobOf(row.file)})`
        : status === 'different-on-main' ? `fails differently with your change: ${row.file} :: ${row.name} (main fails it another way at ${main}; main test job ${jobOf(row.file)})`
        : `fails only with your change: ${row.file} :: ${row.name} (main test job ${jobOf(row.file)})` }];
  }) };
}

/**
 * The summary's failures plus every failing case the run's outcome rows name that the output's tail did not show.
 * Why: the runner keeps only the end of a long output, so a 25-file chunk with 10 failures listed one; the outcome
 * rows cover every case, and `--json` failures[] must list every failing file [C7,#8949].
 *
 * @param {{ file: string | null, name: string, error: string }[]} failures - The failures the output's TAP shows.
 * @param {{ output?: string, outcomes?: object[] | null, failures?: object[] | null }} ran
 * @returns {{ file: string | null, name: string, error: string }[]}
 */
export function withOutcomeFailures(failures, ran) {
  const seen = new Set(failures.map(row => `${row.file}\0${row.name}`));
  const extra = [];
  for (const row of [...failingOutcomes(ran).filter(one => !one.passed && !one.skipped), ...(ran.failures ?? [])]) {
    const name = String(row.name ?? '').slice(0, 300), key = `${row.file}\0${name}`;
    if (!row.file || !name || seen.has(key)) continue;
    // A failure the TAP showed without its file is the same case once its outcome row names the file.
    const unplaced = failures.find(one => !one.file && one.name === name);
    if (unplaced) { unplaced.file = row.file; seen.add(key); continue; }
    seen.add(key);
    extra.push({ file: row.file, name, error: String(row.error ?? row.failure ?? 'no error line recorded') });
  }
  return [...failures, ...extra];
}

/**
 * The case outcomes a pulled run's output names, so a failing case whose TAP carries no file still gets the file its
 * outcome line names: the receipt's own outcomes when it has them, else every frame in the output [C7,#8852].
 *
 * @param {{ output?: string, outcomes?: object[] | null }} ran
 * @returns {object[]}
 */
export function failingOutcomes(ran) {
  const rows = (ran.outcomes ?? []).filter(row => row?.file && row.name);
  if (rows.length) return rows;
  try { return allTestOutcomes(ran.output); } catch { return []; }
}

/** A failing case's own words that say it ran out of time, not that its assertion failed: a fixture that gave no answer, or node:test's timeout [C7,#10597]. */
const TIMING_WORDS = /gave no answer in|test timed out|testTimeoutFailure/u;

/** A file the runner killed: its watchdog's line names it. */
const KILLED_FILE = /run-tests: (?:HUNG|TIMEOUT) file ("(?:[^"\\]|\\.)*")/gu;

/** The block of a failing case's TAP lines: its `not ok` row and the more-indented lines under it. */
function caseBlock(lines, name) {
  const at = lines.findIndex(line => { const row = /^\s*not ok\s+\d+\s+-\s+(.*?)(?:\s+#.*)?$/u.exec(line); return row && name.startsWith(row[1].slice(0, 300)); });
  if (at < 0) return null;
  const indent = /^\s*/u.exec(lines[at])[0].length;
  const block = [lines[at]];
  for (let next = at + 1; next < lines.length && /^\s*/u.exec(lines[next])[0].length > indent; next += 1) block.push(lines[next]);
  return block.join('\n');
}

/** One runner's one-minute load per core over the run, from its receipt's start sample and end average; null when it named no cores. */
export function loadPerCore(ran) {
  const cores = Number(ran.load?.cpus);
  const samples = [ran.loadAtStart, ran.load?.average?.[0]].filter(Number.isFinite);
  return cores > 0 && samples.length ? Math.max(...samples) / cores : null;
}

/**
 * The files a red run should offer once more, or none. With test.loadRerun on, a red whose every failing case is
 * timing-shaped (a fixture that gave no answer, a case that timed out, or a file the runner killed), on a runner whose
 * load per core went over the file-budget load cap, is read as the load's doing. Any failing case that is not
 * timing-shaped, a load at or under the cap, or the setting off, reruns nothing [C7,#10597].
 *
 * @param {{ green: boolean, output: string, failures: { file: string, name: string }[] | null, load?: object | null, loadAtStart?: number | null }} ran
 * @param {string[]} paths - The repo paths the run named.
 * @param {{ enabled?: boolean }} [options] - enabled: test.loadRerun.
 * @returns {string[]} The repo paths to run again; empty when nothing reruns.
 */
export function loadRerunFiles(ran, paths, { enabled = testLoadRerunEnabled() } = {}) {
  if (!enabled || ran.green) return [];
  const perCore = loadPerCore(ran);
  if (perCore === null || !(perCore > testFileLoadScale([Number.MAX_SAFE_INTEGER], 1))) return [];
  const text = String(ran.output ?? '');
  const lines = text.split('\n');
  const pathOf = value => { const seen = String(value ?? '').replace(/^\.\//u, ''); return paths.find(path => seen === path || seen.endsWith(`/${path}`)) ?? null; };
  const killed = [...text.matchAll(KILLED_FILE)].map(found => { try { return pathOf(JSON.parse(found[1])); } catch { return null; } });
  if (killed.includes(null)) return [];
  const red = new Set(killed);
  for (const row of ran.failures ?? []) {
    const file = pathOf(row.file);
    const block = caseBlock(lines, String(row.name));
    // A case the output's tail no longer shows, or whose file the run did not name, is not known to be timing-shaped.
    if (!file || (!killed.includes(file) && !(block && TIMING_WORDS.test(block)))) return [];
    red.add(file);
  }
  return [...red];
}

/**
 * Run named test files as a pulled test job and return the result in the shape runTestFiles returns, so `pullboard
 * test` prints, records and exits as it does today. A red run is compared with main as today's run is: not for one
 * file unless --compare-main, and not when every red file is a known red.
 *
 * @param {object} ctx
 * @param {{ agent?: string, item?: number, files: string[], values: Record<string, any>, knownRed?: (file: string) => string | null, say?: (line: string) => void }} run
 * @returns {Promise<object>}
 */
export async function runPulledTests(ctx, { agent, item, files, values, knownRed, say }) {
  const { root } = ctx.info;
  const config = ctx.config;
  const [{ testFiles }, { retainTestOutput, renderTestSummary }, { mainPolicy }] = await Promise.all([import('../../../../../packages/gate/index.js'), import('../../../../../packages/gate/heavy.js'), import('../../../../../packages/sandbox/index.js')]);
  if (typeof config.affectedTests !== 'string' || !config.affectedTests.trim()) {
    throw new Refused('NO_TEST_RUNNER', 'set "affectedTests" in pullboard.json to the command that runs named test files, like "node apps/cli/src/io/run/tests.js"');
  }
  const paths = testFiles(root, files);
  await refuseUncommitted(root);
  const commit = headCommit(root);
  const policy = mainPolicy(root);
  const main = policy.commit;
  if (!commit || !main) throw new Refused('TEST_SNAPSHOT', 'this checkout has no commit or no accepted main to test against; commit the work and run pullboard test again');
  const started = Date.now();
  const command = `${config.affectedTests.trimEnd()} ${paths.map(path => shellWord('./' + path)).join(' ')}`;
  const budget = fileBudgetField(values).fileBudgetMs ? { fileBudgetMs: fileBudgetField(values).fileBudgetMs } : {};
  let ran = await runJobFor(ctx, { item, commit, main, command, files: paths, ...budget }, { agent, say, testRun: values['test-run'] });
  // With test.loadRerun on, a file red only on timing on an overloaded runner is offered once more and the rerun is reported [C7,#10597].
  const again = loadRerunFiles(ran, paths);
  let loadRerun = null;
  if (again.length) {
    const first = ran;
    ran = await runJobFor(ctx, { item, commit, main, command: `${config.affectedTests.trimEnd()} ${again.map(path => shellWord('./' + path)).join(' ')}`, files: again, ...budget }, { agent, say });
    loadRerun = { files: again, firstRunner: first.runner, firstLoadPerCore: loadPerCore(first), runner: ran.runner, loadPerCore: loadPerCore(ran), green: ran.green };
    say?.(`pullboard test: ${again.join(', ')} red only on timing on ${first.runner ?? 'a runner'} at load ${loadPerCore(first).toFixed(1)} per core; reran once on ${ran.runner ?? 'a runner'} at load ${(loadPerCore(ran) ?? 0).toFixed(1)} per core: ${ran.green ? 'green' : 'red'}`);
  }
  const summary = retainTestOutput(root, ran.output, { profile: { testOutcomes: failingOutcomes(ran) } });
  const shown = summary.failures.length;
  summary.failures = withOutcomeFailures(summary.failures, ran);
  summary.omittedFailures = Math.max(0, summary.omittedFailures - (summary.failures.length - shown));
  // A runner's TAP names a case's file by the runner's own work folder; a failure is shown by the repo path the seat named [C7].
  for (const row of summary.failures) {
    const seen = String(row.file ?? ran.failures?.find(found => found.name === row.name)?.file ?? '').replace(/^\.\//u, '');
    row.file = paths.find(path => seen === path || seen.endsWith(`/${path}`)) ?? row.file;
  }
  const result = { green: ran.green, output: renderTestSummary(summary), ...summary, runner: ran.runner ?? 'a pulled runner', seconds: Math.round((Date.now() - started) / 1000),
    files: paths, known: [], main: null, testJob: ran.job, pulled: true, pulledNotices: [], runFailures: ran.failures, ...(loadRerun ? { loadRerun } : {}) };
  if (ran.green) return result;
  if (paths.length === 1 && values['compare-main'] !== true) { result.mainSkipped = 'one file: add --compare-main to also run it on main'; return result; }
  const redFiles = [...new Set(ran.failures?.map(row => row.file) ?? paths)];
  const reasons = typeof knownRed === 'function' ? redFiles.map(knownRed) : [];
  if (redFiles.length && reasons.length === redFiles.length && reasons.every(Boolean)) { result.mainSkipped = reasons[0]; return result; }
  const runner = typeof policy.config?.affectedTests === 'string' && policy.config.affectedTests.trim() ? policy.config.affectedTests : config.affectedTests;
  const compared = await compareWithMain(ctx, ran, { main, runner, paths, agent, say });
  result.main = main;
  result.pulledNotices = compared.notices;
  result.known = compared.known ?? [];
  // The candidate's signed cases and main's receipt-backed files, which here.js turns into receipt-citing notices [V4,B3].
  result.pulledCases = (ran.failures ?? []).flatMap((row, index) => paths.includes(row.file) && ran.signatures?.[index] ? [{ file: row.file, name: row.name, signature: ran.signatures[index] }] : []);
  result.mainComparison = { main, files: result.known };
  if (compared.unavailable) result.mainUnavailable = compared.unavailable;
  return result;
}
