/**
 * `pullboard test` by pull: under gate.runnerDispatch pull, or for an item the gate.pullPilot setting picks, a test run
 * is one runner job row. This host pins the committed source as a git ref, offers the job and waits on its row; a
 * runner fetches the commit from the trunk remote and runs the files. Nothing here packs code or opens ssh [P7].
 *
 * It is the gate job's machinery with a smaller entry: the same bootstrap archives accepted main on the runner and runs
 * this entry from it, and the runner posts the entry's receipt line, as it does a gate's.
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { Refused } from '../../../../../packages/kernel/light.js';
import { pullGateFor } from '../../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { gateRunnerWaitMs } from '../../../../../packages/config/index.js';
import { git } from '../../../../../packages/git/index.js';
import { headCommit } from '../../../../../packages/git/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { withBoard } from '../context.js';
import { withBoardRead } from '../context.js';

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
const testJobEntry = (GATE_RECEIPT, PULLED_JOB_ENV, TIMING_RUN_ID_ENV, OUTCOME_PREFIX, DIAGNOSTICS) => `import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
const input = JSON.parse(readFileSync(0, 'utf8'));
const started = performance.now();
// A runner job is nobody's subtest: a node:test context inherited from the runner's own host would skip every file.
// This runner is the job's whole execution host, so the run spreads its files over every core [P7,#5790].
// The job's main names the base the candidate's import graph forks from, so its key analysis parses only what changed [C7,#6672].
const env = { ...process.env, ${JSON.stringify(PULLED_JOB_ENV)}: '1', PULLBOARD_TEST_PRIOR: input.main };
delete env.NODE_TEST_CONTEXT;
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
  load: { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) },
  phases: [{ role: 'test', status: ran.status, signal: ran.signal, sha256: createHash('sha256').update(output).digest('hex'), bytes: output.length, tail: '', ...(ran.status !== 0 ? { failures, ...(failureSignatures ? { failureSignatures } : {}) } : {}) }] };
// The receipt line stays under the runner's receipt-line cap: the tail shrinks until the whole line fits.
if (runId) receipt.outcomes = framed();
let keep = 40000, line;
do { receipt.phases[0].tail = text.slice(-keep); line = ${JSON.stringify(GATE_RECEIPT)} + JSON.stringify(receipt); keep = Math.floor(keep / 2); } while (Buffer.byteLength(line) > 56 * 1024 && keep > 0);
// Outcomes too many for the line are dropped whole, so the comparison reads them unavailable, never partial.
if (Buffer.byteLength(line) > 56 * 1024 && receipt.outcomes) { receipt.outcomes = null; receipt.phases[0].tail = text.slice(-4000); line = ${JSON.stringify(GATE_RECEIPT)} + JSON.stringify(receipt); }
process.stdout.write('\\n' + line + '\\n');
process.exitCode = receipt.green ? 0 : 1;
`;

/**
 * True when this test run is a runner job row: under gate.runnerDispatch pull, or when the seat's claimed item is one
 * the pull pilot picks, as its submit would be. `--affected` and `--diagnose` keep the existing path, since their
 * selection and full log are read on this machine.
 *
 * @param {number | undefined} item - The seat's sole claimed item.
 * @param {Record<string, any>} values - The parsed switches.
 */
export function pullTestWanted(item, values) {
  if (values.affected === true || values.diagnose === true) return false;
  return runnerDispatchMode() === 'pull' || (item !== undefined && pullGateFor(Number(item)));
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
 * Pin a commit under refs/pullboard/test and offer one test job for it. Returns the job id and the pinned ref.
 * Why a ref: the trunk remote serves only reachable commits, and an agent's commit is reachable from nothing else yet.
 */
async function offerTestJob(ctx, { item, commit, main, command, files, runId = null }) {
  const { root } = ctx.info;
  const [{ offerJob }, { GATE_NEEDS, GATE_RECEIPT, gateJobRun }, { PULLED_JOB_ENV, TIMING_RUN_ID_ENV, TEST_OUTCOMES_PREFIX }, { FAILURE_DIAGNOSTICS_SOURCE }] = await Promise.all([import('../../../../../packages/api/index.js'), import('../submit/pull.js'),
    import('../../../../../packages/gate/index.js'), import('../../../../../packages/kernel/index.js')]);
  const tag = randomBytes(6).toString('hex');
  const ref = `refs/pullboard/test/${tag}`;
  git(root, ['update-ref', ref, commit]);
  const request = { run: gateJobRun(), input: { main, entry: testJobEntry(GATE_RECEIPT, PULLED_JOB_ENV, TIMING_RUN_ID_ENV, TEST_OUTCOMES_PREFIX, FAILURE_DIAGNOSTICS_SOURCE), data: { main, source: commit, command, files, ...(runId ? { runId } : {}) } }, commits: [main] };
  const job = withBoard(ctx, board => offerJob(board.db, { id: `test:${commit.slice(0, 12)}:${tag}`, kind: TEST_JOB_KIND, priority: 'interactive', needs: GATE_NEEDS,
    item: item === undefined ? null : Number(item), candidate: commit, base: main, request }));
  // With no registered runners this machine is its own runner, as a pull submit makes it: otherwise the job waits unclaimed [P7,C7].
  const [{ primaryCheckoutRoot }, { ensureLocalRunner }] = await Promise.all([import('../worktree.js'), import('../runner/local.js')]);
  const host = primaryCheckoutRoot(ctx.info);
  if (host) await ensureLocalRunner(host);
  return { job: job.id, ref };
}

/**
 * Wait on a job's row until a runner posts its receipt, keeping the seat alive. Refuses when no runner claims it within
 * gate.runnerWaitMs, as a runner-only test run waits today.
 *
 * @returns {Promise<{ receipt: Record<string, any>, runner: string | null }>}
 */
async function receiptOf(ctx, { job, agent, say, wait = pause, pollMs = POLL_MS }) {
  const deadline = Date.now() + gateRunnerWaitMs();
  let beat = 0, claimed = null;
  for (;;) {
    const view = withBoardRead(ctx, board => jobView(board.db, job));
    if (!view) throw new Refused('TEST_JOB_MISSING', `test job ${job} is gone from the board; run pullboard test again`);
    const posted = [...view.steps].reverse().find(step => step.name === 'receipt');
    if (posted) return { receipt: posted.payload.receipt ?? {}, runner: posted.payload.runner ?? null };
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
    await wait(pollMs);
  }
}

/** Run one test job to its receipt and drop its pin; the receipt's phase is the run. */
async function runJobFor(ctx, fields, { agent, say }) {
  const offered = await offerTestJob(ctx, fields);
  say?.(`pullboard test: offered test job ${offered.job} for ${fields.commit.slice(0, 12)}; a runner fetches it from the trunk remote and runs it`);
  try {
    const { receipt, runner } = await receiptOf(ctx, { job: offered.job, agent, say });
    const gate = receipt.gate ?? {};
    const phase = gate.phases?.[0] ?? null;
    const green = receipt.status === 0 && gate.green === true && phase?.status === 0;
    const output = phase?.tail ?? gate.error ?? receipt.tail ?? '';
    const outcomes = Array.isArray(gate.outcomes) ? gate.outcomes.filter(Array.isArray).map(([file, name, passed, skipped]) => ({ file, name, passed, skipped })) : null;
    return { job: offered.job, runner, green, output: String(output), failures: Array.isArray(phase?.failures) ? phase.failures : null,
      signatures: Array.isArray(phase?.failureSignatures) && phase.failureSignatures.length === phase?.failures?.length ? phase.failureSignatures : null, durationMs: receipt.durationMs ?? null, outcomes };
  } finally {
    try { git(ctx.info.root, ['update-ref', '-d', offered.ref]); } catch { /* a pin left behind only keeps a commit reachable */ }
  }
}

/**
 * Run one side of a review comparison as a pulled test job: the files at `commit` under the comparison command, with
 * each case's outcome framed under `runId`. Why a pulled job: the comparison ran over the SSH controller transport,
 * which a local pull runner never claims, so `verify --compare` and the background comparison stopped under pull [V4,C7].
 *
 * @param {object} ctx
 * @param {{ item: number, commit: string, main: string, command: string, files: string[], runId: string, say?: (line: string) => void }} fields
 * @returns {Promise<{ job: string, runner: string | null, green: boolean, output: string, outcomes: { file: string, name: string, passed: boolean, skipped: boolean }[] | null }>}
 */
export async function runPulledComparison(ctx, { item, commit, main, command, files, runId, say }) {
  return runJobFor(ctx, { item, commit, main, command, files, runId }, { say });
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
  const [{ mainRedReceiptId }, { readGateReceipt, receiptStore }] = await Promise.all([import('../../../../../packages/api/index.js'), import('../../../../../packages/gate/index.js')]);
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
  const [{ testFiles, retainTestOutput, renderTestSummary }, { mainPolicy }] = await Promise.all([import('../../../../../packages/gate/index.js'), import('../../../../../packages/sandbox/index.js')]);
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
  const ran = await runJobFor(ctx, { item, commit, main, command, files: paths }, { agent, say });
  const summary = retainTestOutput(root, ran.output);
  // A runner's TAP names a case's file by the runner's own work folder; a failure is shown by the repo path the seat named [C7].
  for (const row of summary.failures) {
    const seen = String(row.file ?? ran.failures?.find(found => found.name === row.name)?.file ?? '').replace(/^\.\//u, '');
    row.file = paths.find(path => seen === path || seen.endsWith(`/${path}`)) ?? row.file;
  }
  const result = { green: ran.green, output: renderTestSummary(summary), ...summary, runner: ran.runner ?? 'a pulled runner', seconds: Math.round((Date.now() - started) / 1000),
    files: paths, known: [], main: null, testJob: ran.job, pulled: true, pulledNotices: [], runFailures: ran.failures };
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
