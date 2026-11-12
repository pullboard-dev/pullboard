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
const testJobEntry = (GATE_RECEIPT, PULLED_JOB_ENV) => `import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
const env = { ...process.env, ${JSON.stringify(PULLED_JOB_ENV)}: '1' };
delete env.NODE_TEST_CONTEXT;
const ran = spawnSync(input.command, { shell: true, cwd: root, env, maxBuffer: 256 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] });
const output = Buffer.concat([ran.stdout ?? Buffer.alloc(0), ran.stderr ?? Buffer.alloc(0)]);
const text = output.toString('utf8') + (ran.error ? String(ran.error.message) : '');
let failures = null;
try {
  const rows = ran.status === 1 && light?.tapFailures ? light.tapFailures(text, root) : null;
  if (Array.isArray(rows) && rows.length && rows.length <= ${CASES} && rows.every(row => row?.file && row.name)) failures = rows.map(({ file, name }) => ({ file, name: String(name).slice(0, 300) }));
} catch { failures = null; }
const receipt = { version: 1, kind: 'test', main: input.main, source: input.source, files: input.files, steps: { test: Math.round(performance.now() - started) },
  environment: { node: process.versions.node, platform: process.platform, arch: process.arch }, green: ran.status === 0,
  phases: [{ role: 'test', status: ran.status, signal: ran.signal, sha256: createHash('sha256').update(output).digest('hex'), bytes: output.length, tail: '', ...(ran.status !== 0 ? { failures } : {}) }] };
// The receipt line stays under the runner's receipt-line cap: the tail shrinks until the whole line fits.
let keep = 40000, line;
do { receipt.phases[0].tail = text.slice(-keep); line = ${JSON.stringify(GATE_RECEIPT)} + JSON.stringify(receipt); keep = Math.floor(keep / 2); } while (Buffer.byteLength(line) > 56 * 1024 && keep > 0);
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
async function offerTestJob(ctx, { item, commit, main, command, files }) {
  const { root } = ctx.info;
  const [{ offerJob }, { GATE_NEEDS, GATE_RECEIPT, gateJobRun }, { PULLED_JOB_ENV }] = await Promise.all([import('../../../../../packages/api/index.js'), import('../submit/pull.js'),
    import('../../../../../packages/gate/index.js')]);
  const tag = randomBytes(6).toString('hex');
  const ref = `refs/pullboard/test/${tag}`;
  git(root, ['update-ref', ref, commit]);
  const request = { run: gateJobRun(), input: { main, entry: testJobEntry(GATE_RECEIPT, PULLED_JOB_ENV), data: { main, source: commit, command, files } }, commits: [main] };
  const job = withBoard(ctx, board => offerJob(board.db, { id: `test:${commit.slice(0, 12)}:${tag}`, kind: TEST_JOB_KIND, needs: GATE_NEEDS,
    item: item === undefined ? null : Number(item), candidate: commit, base: main, request }));
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
    return { job: offered.job, runner, green, output: String(output), failures: Array.isArray(phase?.failures) ? phase.failures : null, durationMs: receipt.durationMs ?? null };
  } finally {
    try { git(ctx.info.root, ['update-ref', '-d', offered.ref]); } catch { /* a pin left behind only keeps a commit reachable */ }
  }
}

/**
 * Compare a red run's failing cases with main's, by one more test job at main: each case either also fails on main or
 * fails only with the change. Null cases mean the run's output did not account for its failures, so no case is named.
 */
async function compareWithMain(ctx, run, { main, config, paths, agent, say }) {
  if (!run.failures) return { notices: [], unavailable: 'the run\'s output does not name every failing case' };
  const files = [...new Set(run.failures.map(row => row.file))].filter(file => paths.includes(file));
  if (!files.length) return { notices: [], unavailable: 'the failing cases are in files the run did not name' };
  const command = `${config.affectedTests.trimEnd()} ${files.map(file => shellWord('./' + file)).join(' ')}`;
  say?.('pullboard test: waiting on the main comparison (--compare-main)');
  const onMain = await runJobFor(ctx, { item: undefined, commit: main, main, command, files }, { agent, say });
  if (!onMain.green && !onMain.failures) return { notices: [], unavailable: `main's run of ${files.join(', ')} names no failing cases` };
  const mainCases = new Set((onMain.failures ?? []).map(row => `${row.file}\0${row.name}`));
  return { notices: run.failures.map(row => {
    const also = mainCases.has(`${row.file}\0${row.name}`);
    return { status: also ? 'also-main' : 'candidate-only', main, file: row.file, name: row.name,
      message: also ? `also fails on main at ${main}: ${row.file} :: ${row.name} (not yours; test job ${onMain.job})` : `fails only with your change: ${row.file} :: ${row.name} (main test job ${onMain.job})` };
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
  const main = mainPolicy(root).commit;
  if (!commit || !main) throw new Refused('TEST_SNAPSHOT', 'this checkout has no commit or no accepted main to test against; commit the work and run pullboard test again');
  const started = Date.now();
  const command = `${config.affectedTests.trimEnd()} ${paths.map(path => shellWord('./' + path)).join(' ')}`;
  const ran = await runJobFor(ctx, { item, commit, main, command, files: paths }, { agent, say });
  const summary = retainTestOutput(root, ran.output);
  const result = { green: ran.green, output: renderTestSummary(summary), ...summary, runner: ran.runner ?? 'a pulled runner', seconds: Math.round((Date.now() - started) / 1000),
    files: paths, known: [], main: null, testJob: ran.job, pulled: true, pulledNotices: [], runFailures: ran.failures };
  if (ran.green) return result;
  if (paths.length === 1 && values['compare-main'] !== true) { result.mainSkipped = 'one file: add --compare-main to also run it on main'; return result; }
  const redFiles = [...new Set(ran.failures?.map(row => row.file) ?? paths)];
  const reasons = typeof knownRed === 'function' ? redFiles.map(knownRed) : [];
  if (redFiles.length && reasons.length === redFiles.length && reasons.every(Boolean)) { result.mainSkipped = reasons[0]; return result; }
  const compared = await compareWithMain(ctx, ran, { main, config, paths, agent, say });
  result.main = main;
  result.pulledNotices = compared.notices;
  if (compared.unavailable) result.mainUnavailable = compared.unavailable;
  return result;
}
