import { createHash } from 'node:crypto';
import { submitFixture } from './board/submit.js';
import { templatedProject } from './template.js';
import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from './child.js';
import { reportFixtureChildFailure } from './child.js';
import { runFixtureChild } from './child.js';
import { runFixtureChildAsync } from './child.js';
import { runFixtureSetupGit } from './child.js';
import { performance } from 'node:perf_hooks';
import { appendFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sharedCompileCache } from './sandbox/compile-cache.js';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { resolve } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { SSH_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { fetchFresh } from './http.js';
import { stopFixtureLocalRunners } from './runner/local-stop.js';
import { stopComparisonWorkers } from './runner/comparisons.js';
import { reviveFixtureLocalRunner } from './runner/local-start.js';
import { CLI_ENTRY } from './runner/entry.js';
import { runnerSwitchedEnv } from './runner/switches.js';
import { runCliInProcess } from './process.js';
import { runCliSync } from './sync/cli.js';
import { fetchPrintedViewLink } from './view/link.js';
import { fileFixtureItem } from './testkit.js';
import { fixtureAddRoute } from './testkit.js';
import { fixtureJoinRoute } from './testkit.js';
import { fixtureSettledMachine } from './testkit.js';
import { commitInProcess } from './hook/commit.js';
import { inProcessHooksOn } from './hook/mode.js';
import { fixtureProjectPolicy } from './testkit.js';
import { joinFixtureSeat } from './testkit.js';

/**
 * How runIn and runLocal reach the CLI: in this process by default. PULLBOARD_JOURNEY_MODE=process runs the same call as its own
 * process instead, so the gate's parity check can run one journey both ways and compare them (#8257) [C7].
 */
export const JOURNEY_MODE = process.env.PULLBOARD_JOURNEY_MODE === 'process' ? 'process' : 'inprocess';

/** Machine-dependent text in a CLI answer: the private sandbox folder, times, ids, hashes and durations. */
export function parityText(text, dir) {
  return String(text ?? '').split(dir).join('<dir>')
    // A real script process prints node's experimental-feature warning; the same code run in this process does not (the warning already fired once).
    .replace(/\(node:\d+\) ExperimentalWarning: [^\n]*\n\(Use `node --trace-warnings[^\n]*\n/gu, '')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/gu, '<time>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d(?=  )/gu, '<time>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<uuid>')
    .replace(/\b[0-9a-f]{7,64}\b/gu, '<hex>')
    .replace(/(<hex>\.)[\w-]{20,}\.[\w-]{20,}/gu, '$1<token>')
    .replace(/\b\d+(?:\.\d+)? ?(?:ms|s)\b/gu, '<duration>')
    .replace(/(gate:\d+:<hex>):[0-9a-z]+/gu, '$1:<job>')
    .replace(/(gate-\d+-<hex>)-[0-9a-z]+-\d+/gu, '$1-<job>')
    .replace(/\b(local-[a-z]+-\d+-[a-z]+)-\d{3,}\b/gu, '$1-<pid>')
    .replace(/\b(local-[a-z]+\.local)-\d+\b/gu, '$1-<pid>') // the local runner's name carries its process id
    // The detached comparison worker records its result at no fixed moment, so a call sees it pending, complete or unavailable: a background-measured value.
    .replace(/^comparison (?:pending for #\d+|unavailable: .*|#\d+.*(?:\n(?:head |base |new red:|fixed:|No new red).*)*)$/gmu, '<comparison>')
    .replace(/"steps":\{[^}]*\}/gu, '"steps":"<steps>"')
    .replace(/\(pid \d+\)/gu, '(pid <pid>)')
    // The detached comparison worker also writes its own thread facts at no fixed moment, so the lines and the digest's fact count follow timing, not the runtime.
    .replace(/^ +<time> +.*fact measurement <uuid>: Review comparison: .*\n/gmu, '')
    .replace(/\b\d+ fact activities\b/gu, '<n> fact activities')
    // The add's check-baseline job runs on the loopback local runner at no fixed moment, and a seat's first delivery starts at the board head,
    // so its event shows in the second submit's digest only when it lands after the first submit's delivery: call speed, not the runtime (#10746).
    // Only that one digest line goes; the board's event counts still compare.
    .replace(/^\d+ check-baseline activit(?:y|ies); details remain on the board\n?/gmu, '')
    .replace(/"pid":\d+/gu, '"pid":"<pid>"')
    // Whether init's background view starts or finds port 4890 taken depends on what else runs on the machine, not on the runtime.
    .replace(/Pullboard view is running; open [^"\\]*|Port \d+ is in use; the background view did not start\./gu, '<view state>');
}

/**
 * One call's result for the parity check: argv, exit code, the JSON result or the printed text, and the board's items and
 * event counts after the call, all with machine-dependent text masked. Read-only: the board is opened read-only [C7].
 */
export function parityRecord({ dir, env, cwd, args, result }) {
  let json = null;
  try { json = JSON.parse(result.out); } catch { /* a text answer */ }
  let board = null;
  const common = runFixtureChild('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, env, encoding: 'utf8' });
  const file = common.status === 0 ? join(common.stdout.trim(), 'pullboard', 'board.sqlite') : null;
  // A command that hands a gate job on finishes its board writes when a runner posts the receipt, at no fixed moment after it
  // returns, so its own record carries no board state; the next call's record compares the settled board instead.
  if (file && existsSync(file) && !(result.code === 0 && JOB_OFFERING.has(args[0]))) {
    // @pullboard-board-file journey: a read-only look at the rows the command wrote, for the parity check.
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      // api_stall records a slow machine, not a product result: the parity runs share a loaded machine, so it is left out.
      // gate-queue is a fleet snapshot a runner's pull claim appends only when the queue differs from the last one, so how many land by this read depends on poll timing, not on the call.
      board = { items: db.prepare('SELECT item_id, item_status, item_lane FROM item ORDER BY item_id').all().map(row => ({ ...row })),
        events: db.prepare("SELECT event_kind, count(*) AS n FROM event WHERE event_kind NOT IN ('api_stall', 'gate-queue') AND NOT (event_kind = 'fact' AND event_detail LIKE '%Review comparison:%') GROUP BY event_kind ORDER BY event_kind").all().map(row => ({ ...row })) };
    } finally { db.close(); }
  }
  // Mask string values only: a bare number of 7 or more digits would read as a hash and break the JSON it sits in.
  // Also masked: the disk-use measurement status prints (apps/cli/src/io/disk/use.js). A detached worker measures the store sizes
  // at no fixed moment, so whether a call sees "measuring" or a total, and the byte counts, depend on timing, not on the runtime.
  const DISK_MEASURED = ['total', 'stores', 'measuredAt', 'measuring', 'warning'];
  const mask = (value, key) => key === 'comparison' ? '<comparison>'
    : key === 'pid' && typeof value === 'number' ? '<pid>' // a runner's process id
    : value?.kind === 'fact' && typeof value.count === 'number' ? mask({ ...value, count: '<n>' }) // the digest counts the late comparison fact
    : key === 'steps' && value && typeof value === 'object' && Object.values(value).every(Number.isFinite) ? '<steps>' // gate step timings, in milliseconds
    : typeof value === 'number' && /Ms$/u.test(key ?? '') ? '<ms>' // a measured duration
    : typeof value === 'number' && key === 'pid' ? '<pid>' // a process id of a gate's test runtime
    : typeof value === 'string' ? parityText(value, dir).replace(/^disk use under \.git\/pullboard: .*$/gmu, 'disk use under .git/pullboard: <measured>')
    // The late comparison fact and the gate job offer fact are background values (one runtime sees them in a thread, the other later); they also move every later event id.
    : (key === 'eventId' || key === 'acceptEventId' || key === 'supersedes' || key === 'cursor') && typeof value === 'number' ? '<event>' // a cursor or an accept id counts the late comparison fact too
    : Array.isArray(value) ? value.filter(inner => !(inner?.type === 'fact' && /^(?:Review comparison: |Gate job \S+ offered for )/u.test(inner.text ?? ''))).map(inner => mask(inner))
    : value && typeof value === 'object' ? Object.fromEntries([...Object.entries(value).filter(([name]) => key !== 'disk' || !DISK_MEASURED.includes(name)).map(([name, inner]) => [name, mask(inner, name)]),
      ...(key === 'disk' ? [['measurement', '<measured>']] : [])]) : value;
  return mask({ cwd, args, code: result.code, json, out: json ? null : result.out, err: result.stderr, board });
}

/**
 * One journey CLI call for a fixture of its own: answered in this process by default, or as a real process under
 * PULLBOARD_JOURNEY_MODE=process, and appended to PULLBOARD_PARITY_RECORD when the parity check asks for it (#8267) [C7].
 * Why: the same record shape as runIn, so files whose box is not createE2eHelpers can join the parity sample.
 * @param {{ dir: string, env: object, cwd: string, args: string[], inProcess: () => Promise<{status: number, stdout: string, stderr: string}>, real?: () => {status: number, stdout: string, stderr: string}, bin?: string }} call The call, both ways; `bin` (the CLI entry file) lets the kit start the real process itself, so a test file never launches one.
 * @returns {Promise<{status: number, stdout: string, stderr: string}>} The answer.
 */
export async function journeyCall({ dir, env, cwd, args, inProcess, bin, real = () => runFixtureChild(process.execPath, [bin, ...args], { cwd, env, encoding: 'utf8' }) }) {
  const result = JOURNEY_MODE === 'process' ? real() : await inProcess();
  if (process.env.PULLBOARD_PARITY_RECORD) {
    const answer = { code: result.status, out: result.stdout, stderr: result.stderr };
    appendFileSync(process.env.PULLBOARD_PARITY_RECORD, `${JSON.stringify(parityRecord({ dir, env, cwd, args, result: answer }))}\n`);
  }
  return result;
}

/** The model every fixture board runs as, whatever the parent process was launched with [C7]. */
export const FIXTURE_MODEL = 'fixture-model';

/**
 * A copy of an environment with every PULLBOARD_ variable removed, so a fixture never inherits the
 * agent's identity or home. Each fixture sets the PULLBOARD_ values it needs on top of this copy.
 * The copy sets PULLBOARD_FIXTURE_ADD_DISTINCT=1: fixture items carry numbered, near-identical titles, so the duplicate
 * guard of `add` stays off in every fixture board; its own journey deletes the variable to prove the guard (#6864).
 * @param {Record<string, string | undefined>} source The parent process environment.
 * @returns {Record<string, string | undefined>} A new object without PULLBOARD_ keys.
 */
export function withoutPullboardEnv(source) {
  return { ...Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('PULLBOARD_'))), PULLBOARD_FIXTURE_ADD_DISTINCT: '1' };
}

/** The commands that may offer a runner job (a gate, test or land job) a journey then reads the outcome of. */
const JOB_OFFERING = new Set(['submit', 'verify', 'land', 'accept', 'test', 'ship', 'resubmit', 'run']);
/** Budget: how long a fixture command waits for the loopback local runner to finish the jobs it offered. */
const SETTLE_MS = 180_000;

/**
 * Wait until the fixture board's runner job queue holds no unfinished job, so a journey reads a settled gate or landing.
 * Why: under pull dispatch a submit offers its gate as a job the loopback local runner takes and returns at once; the
 * journeys assert what the gate decided, so the fixture command returns once the queue is done [P7,#5821].
 *
 * @param {string} cwd - Where the command ran.
 * @param {string[]} args - The command's arguments.
 * @param {object} env - The fixture environment.
 */
export function settlePulledJobs(cwd, args, env) {
  // A status or cancel read offers no job and must not hold the command; a journey serving its own runner returns at once (#6660).
  // A controller-dispatch fixture drives its gate in the command's own detached workers, whose rows (the hand-off gate, its
  // drive job, the dispatcher lease) stay open while the journey still holds its gate, so waiting here deadlocked it.
  if (env.PULLBOARD_FIXTURE_UNSETTLED === '1' || !JOB_OFFERING.has(args[0]) || args.includes('--help') || args.includes('--status') || args.includes('--cancel')) return;
  const common = runFixtureChild('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, env, encoding: 'utf8' });
  if (common.status !== 0) return;
  const file = join(common.stdout.trim(), 'pullboard', 'board.sqlite');
  if (!existsSync(file)) return;
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    let open = false;
    // @pullboard-board-file journey: a read-only look at the queue the real CLI wrote rows to.
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try { open = Boolean(db.prepare("SELECT 1 FROM job WHERE job_step <> 'done' LIMIT 1").get()); } finally { db.close(); }
    } catch (error) { if (!/database is locked/u.test(String(error?.message))) return; open = true; }
    if (!open || Date.now() >= deadline) return; reviveFixtureLocalRunner(cwd, env, { entry: CLI_ENTRY }); // A gate switch stopped it (runnerSwitchedEnv).
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

/**
 * Resolve when the loopback local runner's folder changes (a log line per claim and receipt, a heartbeat every 5 s), or after
 * 1 s as a backstop; the board is then read again. Why events: a fixed sleep blocked nothing here but waited blind [C7].
 *
 * @param {object} env - The fixture environment.
 * @returns {Promise<void>} Resolves on the next change.
 */
function runnerFolderChange(env) {
  return new Promise(resolve => {
    let watcher = null;
    const finish = () => { watcher?.close(); clearTimeout(backstop); resolve(); };
    const backstop = setTimeout(finish, 1_000);
    try { watcher = watch(join(env.PULLBOARD_MACHINE_HOME ?? '', 'local-runner'), finish); } catch { /* no runner folder: the backstop reads again */ }
  });
}

/**
 * The same wait as settlePulledJobs without blocking this process: concurrent cases of one journey file overlap their gate waits
 * instead of each holding the whole event loop while its loopback runner works [C7].
 *
 * @param {string} cwd - Where the command ran.
 * @param {string[]} args - The command's arguments.
 * @param {object} env - The fixture environment.
 */
export async function settlePulledJobsAsync(cwd, args, env) {
  // A status or cancel read offers no job and must not hold the command; a journey serving its own runner returns at once (#6660).
  // A controller-dispatch fixture drives its gate in the command's own detached workers, whose rows (the hand-off gate, its
  // drive job, the dispatcher lease) stay open while the journey still holds its gate, so waiting here deadlocked it.
  if (env.PULLBOARD_FIXTURE_UNSETTLED === '1' || !JOB_OFFERING.has(args[0]) || args.includes('--help') || args.includes('--status') || args.includes('--cancel')) return;
  const common = runFixtureChild('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, env, encoding: 'utf8' });
  if (common.status !== 0) return;
  const file = join(common.stdout.trim(), 'pullboard', 'board.sqlite');
  if (!existsSync(file)) return;
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    let open = false;
    // @pullboard-board-file journey: a read-only look at the queue the real CLI wrote rows to.
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try { open = Boolean(db.prepare("SELECT 1 FROM job WHERE job_step <> 'done' LIMIT 1").get()); } finally { db.close(); }
    } catch (error) { if (!/database is locked/u.test(String(error?.message))) return; open = true; }
    if (!open || Date.now() >= deadline) return; reviveFixtureLocalRunner(cwd, env, { entry: CLI_ENTRY }); // A gate switch stopped it (runnerSwitchedEnv).
    await runnerFolderChange(env);
  }
}

/** The pids of the background views a sandbox's commands started, from the session files in its private Pullboard home. */
function sandboxViewPids(dir) {
  const home = join(dir, 'pullboard-home');
  let names = [];
  try { names = readdirSync(home).filter(name => /^view-\d+\.json$/u.test(name)); } catch { return []; }
  return names.flatMap(name => {
    try {
      const pid = Number(JSON.parse(readFileSync(join(home, name), 'utf8')).pid);
      return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid ? [pid] : [];
    } catch { return []; }
  });
}

/** Create isolated real-repository helpers for one parallel end-to-end test file. */
export function createE2eHelpers() {
  const sandboxes = [];
  const compileCache = sharedCompileCache();
  /**
   * Remove this test file's fixtures after its tests finish. A detached writer (a gate or board worker a
   * fixture command started) can still be flushing into the tree on a loaded runner, so the removal waits up
   * to 30 s for it to stop; the 1 s budget failed pending-refreeze with ENOTEMPTY (#3192).
   */
  const cleanup = () => {
    // A background view an in-process init started is this process's own child, and the test file cannot end while it runs [C7].
    const views = sandboxes.flatMap(sandboxViewPids);
    for (const pid of views) { try { process.kill(pid, 'SIGTERM'); } catch { /* it has exited */ } }
    // Every runner is signalled before any is awaited, so five sandboxes cost one stop, not five [C7].
    stopFixtureLocalRunners(sandboxes.map(dir => join(dir, 'machine-home')));
    for (const pid of views) { try { process.kill(pid, 'SIGKILL'); } catch { /* it has stopped */ } }
    for (const dir of sandboxes) {
      stopComparisonWorkers(dir);
      const deadline = Date.now() + 30_000;
      for (;;) {
        try { rmSync(dir, { recursive: true, force: true }); break; }
        catch (error) {
          if (!['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE'].includes(error.code) || Date.now() >= deadline) throw error;
          // A writer can recreate files after traversal; retry the whole tree, not just the failed rmdir.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(200, deadline - Date.now()));
        }
      }
    }
    compileCache.remove();
  };
const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const cockpitSource = () => readFileSync(resolve(import.meta.dirname, '../../src/io/cockpit.js'), 'utf8');

/**
 * A scratch directory with a `pullboard` shim on the PATH, so the hooks git runs find the CLI, and
 * git isolated from the machine's own config.
 */
function sandbox({ declareFamilies = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-e2e-')));
  sandboxes.push(dir);
  const shims = join(dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = runnerSwitchedEnv({
    ...withoutPullboardEnv(process.env),
    PATH: `${shims}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    // A fixture board's nested pullboard test starts at once; the outer gated run owns the load budget (#7257).
    PULLBOARD_FIXTURE_BOARD: '1',
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    // Fixtures read usage right after a move; the detached checkpoint has its own proof [N2].
    PULLBOARD_USAGE_CHECKPOINT: 'inline',
    // A fixture's infrastructure retry does not wait out the real 30 s back-off (#3365).
    PULLBOARD_INFRA_RETRY_BACKOFF_MS: '0',
    // A fixture's claims start no detached claim beater bound to the test process; its own journey turns it on (#5726).
    PULLBOARD_CLAIM_BEATER: '0',
    // init and resume start no background view in a fixture, in a real process or in-process: a busy port must not change an answer [C7].
    PULLBOARD_VIEW_BACKGROUND: '0',
    // A fixed fixture model, so no fixture reads the machine's or the agent seat's identity [C7].
    PULLBOARD_MODEL: FIXTURE_MODEL,
    // Every sandbox of this file compiles the CLI once, not once per sandbox: one shared compile cache [C7,#10415].
    NODE_COMPILE_CACHE: compileCache.folder,
    // The loopback local runner a pull submit starts stops with this test process, never outliving the journey [P7].
    ...(process.env.PULLBOARD_TEST_RUNNER_PID ? { PULLBOARD_TEST_RUNNER_PID: process.env.PULLBOARD_TEST_RUNNER_PID } : {}),
  });
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[marker];
  delete env.PULLBOARD_RELAY_TOKEN;
  // A journey's submit settles the same way whatever the machine's dispatch default is [P7].
  fixtureSettledMachine(env.PULLBOARD_MACHINE_HOME);
  const git = (cwd, ...args) => runFixtureSetupGit(args, { cwd, env });
  // With test.inProcessHooks on, a plain `commit -m` runs both hooks in this process and answers with a promise; every other call is git as before [C7,#9215].
  const tryGit = (cwd, ...args) => (inProcessHooksOn(env) ? commitInProcess({ env }, cwd, args) : null) ?? runFixtureChild('git', args, { cwd, env, encoding: 'utf8' });
  const declaredFamilies = new Map();
  /** Explicit private vendor labels are fixture data, independent of model and parent identity. */
  const declareFamily = (cwd, family) => {
    const value = family ?? `Fixture Vendor ${declaredFamilies.size + 1}`;
    declaredFamilies.set(cwd, value);
    return value;
  };
  /** Apply the fixture's join family and default routes to one argv, as every box call does. */
  const prepare = (cwd, args) => {
    if (declareFamilies && args[0] === 'join') {
      const familyFlag = args.findIndex(arg => arg === '--family' || arg.startsWith('--family='));
      if (familyFlag >= 0) declareFamily(cwd, args[familyFlag].startsWith('--family=') ? args[familyFlag].slice(9) : args[familyFlag + 1]);
      else if (!declaredFamilies.has(cwd)) args.push('--family', declareFamily(cwd));
    }
    // A test of the board's own default routing sets PULLBOARD_FIXTURE_ROUTES=board to receive the routes it asks for.
    if (env.PULLBOARD_FIXTURE_ROUTES !== 'board') {
      fixtureJoinRoute(args, env.PULLBOARD_MODEL);
      fixtureAddRoute(args);
    }
  };
  const run = (cwd, ...args) => {
    prepare(cwd, args);
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    if (result.status === 0) settlePulledJobs(cwd, args, env);
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr, failure: result.failure };
  };
  /** The same call as run in its own process without blocking this one, so a journey runs several CLI calls at once. */
  const runAsync = async (cwd, ...args) => {
    prepare(cwd, args);
    const result = await runFixtureChildAsync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    if (result.status === 0) await settlePulledJobsAsync(cwd, args, env);
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr, failure: result.failure, rawStderr: result.stderr };
  };
  /** The same call as run, answered by the production dispatcher in this process; no node start-up (about 1 s saved). */
  const inProcess = async (cwd, ...args) => {
    prepare(cwd, args);
    const result = await runCliInProcess(args, { cwd, env });
    if (result.status === 0) await settlePulledJobsAsync(cwd, args, env);
    return { code: result.status, out: result.stdout, err: result.stderr, failure: null, status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  /** The same call as inProcess, answered synchronously by a warm worker thread, for synchronous setup such as project() [C7]. */
  const runSync = (cwd, ...args) => {
    prepare(cwd, args);
    const result = runCliSync(args, { cwd, env });
    return { code: result.status, out: result.stdout, err: result.stderr, failure: null, status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  runSync.of = run;
  /** The journey's call: inProcess, or a real process under PULLBOARD_JOURNEY_MODE=process; PULLBOARD_PARITY_RECORD appends each call's record. */
  const runIn = async (cwd, ...args) => {
    const called = [...args];
    const result = JOURNEY_MODE === 'process' ? await runAsync(cwd, ...args) : await inProcess(cwd, ...args);
    const answer = { ...result, status: result.code, stdout: result.out, stderr: result.rawStderr ?? result.err };
    if (process.env.PULLBOARD_PARITY_RECORD) appendFileSync(process.env.PULLBOARD_PARITY_RECORD, `${JSON.stringify(parityRecord({ dir, env, cwd, args: called, result: answer }))}\n`);
    return answer;
  };
  /** A read of the board that is not the journey's subject, such as the settle wait's poll: in this process, whatever the mode, and recorded nowhere, so the parity call count follows no timing (U149) [C7]. */
  runIn.read = inProcess;
  return { dir, env, git, tryGit, run, runAsync, inProcess, runLocal: runIn, runIn, runSync, parityRecord, declareFamilies, declareFamily };
}

const CONFIG = {
  gate: 'test ! -f RED',
  spec: 'SPEC.md',
  verify: 'any',
  lease: '2h',
  landing: { perItem: false, manualOverride: true },
  lanes: { web: { owns: ['web/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } },
  shared: ['docs/'],
};

const SPEC = `# Demo spec

## G · Goals
- G1 [approved, must] The page renders. | gate: web test
- G2 [approved, must] The API answers. | gate: api test
`;

/**
 * A repo set up with pullboard, two lanes and a spec, committed through its own hooks, plus a
 * worktree joined to the web lane. Vendors stay undeclared by default; setting-on cases use
 * sandbox({ declareFamilies: true }) for explicit synthetic labels. The coordinator's model
 * stays deliberately undeclared; later agents retain the runner's model.
 * Coordinator-only fixtures may omit the unused worktree and its join.
 */
function project(gate = CONFIG.gate, box = sandbox(), options = {}) {
  // The first case in a process builds; every later case of the same shape copies that project [C7,#8088].
  return templatedProject(box, JSON.stringify([gate, options]), () => buildProject(gate, box, options));
}

/** Build one project from nothing; project() calls it once per shape and process. */
function buildProject(gate, box, { separateGitDir = false, withWorktree = true }) {
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main', ...(separateGitDir ? ['--separate-git-dir', join(box.dir, 'separate-git')] : []));
  const inheritedModel = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  // Setup init and join run in the warm worker: a project is what a journey starts from, not what it tests [C7].
  // A box whose run a test replaced keeps that run, so the test still observes its own setup calls.
  const setupRun = box.runSync?.of === box.run ? box.runSync : box.run;
  const initialized = setupRun(repo, 'init');
  assert.equal(initialized.code, 0, initialized.err);
  if (box.declareFamilies) withFixtureBoard({ ...box, repo }, board => {
    store.register(board, { lane: 'coordinator', path: repo, family: box.declareFamily(repo, 'Fixture Coordinator Vendor') });
  });
  box.git(repo, 'config', 'user.name', 'Test Agent');
  box.git(repo, 'config', 'user.email', 'agent@example.com');
  if (inheritedModel !== undefined) box.env.PULLBOARD_MODEL = inheritedModel;
  // One live claim per seat, as the journeys assume, whatever free runner slots the machine reports [C7].
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, claims: { ...CONFIG.claims, perSeat: 1 }, gate }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  if (!withWorktree) return { ...box, repo };
  const web = join(box.dir, 'web-1');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const joined = joinFixtureSeat(box, web, 'web', { model: 'fixture-model', run: setupRun });
  assert.equal(joined.code, 0, `fixture join failed (code ${joined.code}): ${joined.err}\n${joined.out}`);
  const seat = JSON.parse(joined.out);
  assert.equal(seat.agent, 'web-1');
  assert.equal(seat.lane, 'web');
  assert.equal(seat.route, 'strong');
  assert.equal(seat.model, 'fixture-model');
  return { ...box, repo, web };
}

/** Create a private gate that waits only after the test arms it. */
function holdingGate(box) {
  const script = join(box.dir, 'holding-gate.cjs');
  const mode = join(box.dir, 'hold-gate');
  const release = join(box.dir, 'release-gate');
  const events = join(box.dir, 'gate-events.log');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    'const [armed, release, events] = process.argv.slice(2);',
    'if (!fs.existsSync(armed)) process.exit(0);',
    "fs.appendFileSync(events, 'start\\n');",
    'const deadline = Date.now() + 180000; // budget: hang ceiling while a test observes the held gate; no elapsed-time assertion.',
    'while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
    'if (!fs.existsSync(release)) process.exit(23);',
    "fs.appendFileSync(events, 'end\\n');",
  ].join('\n'));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return { command: `${quote(process.execPath)} ${quote(script)} ${quote(mode)} ${quote(release)} ${quote(events)}`, mode, release, events };
}

/** Launch a CLI or Git process while preserving its output for the gate-lock assertion. */
function launch(box, cwd, command, args) {
  const startedAt = performance.now();
  const child = spawn(command, args, { cwd, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { child.stdoutText += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { child.stderrText += chunk; });
  child.closed = new Promise((resolveClose) => {
    let reported = false;
    const reportFailure = (code, signal, extra = '') => {
      if (reported) return;
      reported = true;
      child.failure = reportFixtureChildFailure({ command, args, status: code, signal,
        elapsedMs: performance.now() - startedAt, stderr: child.stderrText, env: box.env, detail: extra });
    };
    child.once('error', (error) => reportFailure(null, null, error.message));
    child.once('close', (code, signal) => {
      if (code !== 0 || signal) reportFailure(code, signal);
      resolveClose({ code, signal, failure: child.failure ?? null });
    });
  });
  return child;
}

/** Wait for a private fixture observation with a bounded failure time. */
async function waitFor(predicate, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Read the private gate event sequence without exposing arbitrary gate output. */
function gateEvents(gate) {
  return existsSync(gate.events) ? readFileSync(gate.events, 'utf8').trim().split(/\r?\n/u).filter(Boolean) : [];
}

/**
 * Write a file in a worktree and commit it, returning git's result so a refusal can be read.
 */
function commitFile(box, cwd, path, text, message) {
  mkdirSync(join(cwd, path, '..'), { recursive: true });
  writeFileSync(join(cwd, path), text);
  box.git(cwd, 'add', '-A');
  return box.tryGit(cwd, 'commit', '-q', '-m', message);
}

const LIGHT_BRIEF = 'Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n';

async function startView(box, cwd, { nodeArgs = [] } = {}) {
  const startedAt = performance.now();
  const args = [...nodeArgs, BIN, 'view', '--no-open', '--port', '0'];
  const child = spawn(process.execPath, args, { cwd, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' } });
  const link = await new Promise((found, fail) => {
    let out = '';
    let stderr = '';
    let settled = false;
    const rejectStartup = (code, signal, extra = '') => {
      if (settled) return;
      settled = true;
      const failure = reportFixtureChildFailure({ command: process.execPath, args,
        status: code, signal, elapsedMs: performance.now() - startedAt, stderr, env: box.env, detail: extra });
      fail(new Error(failure));
    };
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(out);
      if (match && !settled) { settled = true; found(new URL(match[1])); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => rejectStartup(null, null, error.message));
    child.once('exit', (code, signal) => rejectStartup(code, signal));
  });
  const key = link.searchParams.get('k');
  const base = `http://127.0.0.1:${link.port}`;
  const headers = { 'x-pullboard-key': key };
  /** Read the page through either the legacy link or the cookie exchange. */
  const page = () => fetchPrintedViewLink(link);
  /** Read the public listing through the view's real authenticated API. */
  const boards = async () => {
    const response = await fetchFresh(`${base}/api/v1/boards`, { headers });
    return { status: response.status, document: await response.json() };
  };
  /** Resolve a registered board id and read full public state for test ground truth. */
  const state = async (root) => {
    const listing = await boards();
    if (listing.status !== 200) return listing;
    const board = listing.document.boards.find((entry) => entry.root === root);
    if (!board) return { ...listing.document, project: null };
    const response = await fetchFresh(`${base}/api/v1/boards/${encodeURIComponent(board.id)}/state?detail=full`, { headers });
    return { ...listing.document, project: (await response.json()).state };
  };
  /** Send a public move to the registered board or a deliberately unknown id. */
  const act = async (root, body) => {
    const listing = await boards();
    const board = listing.document.boards?.find((entry) => entry.root === root);
    const id = board?.id ?? '0'.repeat(32);
    const response = await fetchFresh(`${base}/api/v1/boards/${encodeURIComponent(id)}/moves`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, document: await response.json() };
  };
  const stop = () => new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once('exit', done);
    child.kill('SIGTERM');
  });
  return { link, key, base, page, state, act, stop };
}

function attackCommit(box, cwd) {
  box.git(cwd, 'add', '-A');
  const tree = box.git(cwd, 'write-tree');
  const commit = box.git(cwd, 'commit-tree', tree, '-p', 'HEAD', '-m', 'feat(web): adversarial fixture [G1]');
  box.git(cwd, 'update-ref', 'HEAD', commit);
  return commit;
}

/** Reopen the CLI's actual SQLite file to seed private integration data that later CLI processes read. */
function withFixtureBoard(box, work) {
  // File-backed boundary: subsequent real CLI processes must read these exact persisted fixture rows.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try { return work(board); }
  finally { store.closeBoard(board); }
}

/** Seed a legacy receipt from the old full-gate-only submit rule, for independent verifier audits. */
function historicalCheckSubmission(box, commit) {
  box.git(box.web, 'update-ref', `refs/pullboard/items/1/${commit.slice(0, 12)}`, commit);
  withFixtureBoard(box, board => submitFixture(board, 1, { agentId: 'web-1', commit, tree: box.git(box.web, 'rev-parse', `${commit}^{tree}`) }));
}

/** Retain historical submissions whose private check needs an install, fails, or times out. */
function privateCheckSubmission({ install = '', timeout = '5m', check }) {
  const box = project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.check = { install, timeout };
  fixtureProjectPolicy(box.repo, { config });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure private check fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Private check', criterion: 'the installed check passes', check, args: ['--specs', 'G1'] });
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/.gitignore'), '.deps/\n');
  writeFileSync(join(box.web, 'web/index.html'), 'fixture');
  const commit = attackCommit(box, box.web);
  historicalCheckSubmission(box, commit);
  const review = join(box.dir, 'private-check-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(joinFixtureSeat(box, review, 'api').code, 0);
  const reserved = box.run(review, 'next', '--verify', '1', '--json');
  assert.equal(reserved.code, 0, reserved.out || reserved.err);
  return { ...box, review, commit };
}


  return {
    BIN, cockpitSource, sandboxes, cleanup, sandbox, CONFIG, SPEC, project,
    holdingGate, launch, waitFor, gateEvents, commitFile, attackCommit, historicalCheckSubmission, privateCheckSubmission,
    startView, LIGHT_BRIEF,
  };
}

/** Run the public CLI in one private session without letting a peer inherit its identity. */
export function crossLaneFixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixture = helpers.sandbox();
  fixture.env.PULLBOARD_MODEL = 'Cross-lane test';
  const box = helpers.project('true', fixture);
  const session = 'cross-lane-owner-session';
  /** Setup calls (seats, items, milestones) run in the warm worker, as project() does; a test that replaced box.run keeps its own [C7]. */
  const setup = box.runSync?.of === box.run ? box.runSync : box.run;
  /** Each command gets its actual invoking session, and the surrounding fixture keeps none. */
  function runAs(identity, cwd, ...args) {
    const previous = { CLAUDECODE: box.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: box.env.CLAUDE_CODE_SESSION_ID };
    box.env.CLAUDECODE = '1';
    box.env.CLAUDE_CODE_SESSION_ID = identity;
    try { return setup(cwd, ...args); }
    finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete box.env[name];
        else box.env[name] = value;
      }
    }
  }
  /** The same identity swap as runAs, answered by the production dispatch in this process [C7]. */
  async function runAsLocal(identity, cwd, ...args) {
    const previous = { CLAUDECODE: box.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: box.env.CLAUDE_CODE_SESSION_ID };
    box.env.CLAUDECODE = '1';
    box.env.CLAUDE_CODE_SESSION_ID = identity;
    try { return await box.runLocal(cwd, ...args); }
    finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete box.env[name];
        else box.env[name] = value;
      }
    }
  }
  /** Demand real command success before interpreting its versioned result. */
  function json(result) {
    assert.equal(result.code, 0, `${result.out}\n${result.err}`);
    return JSON.parse(result.out);
  }
  /** An existing seat is joined by the actual owner session, rather than a test-only owner flag. */
  function seat(name, lane, identity, route = 'strong', lockLane = false) {
    const root = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, 'main');
    return { ...json(joinFixtureSeat(box, root, lane, { route, lockLane, model: 'Cross-lane test', run: (cwd, ...args) => runAs(identity, cwd, ...args) })), root };
  }
  /** Add an ordinary routed item through the coordinator CLI with its lane's approved row; each title names its own file so items never collide on one path. */
  function add(lane, title, route = 'strong') {
    return fileFixtureItem(box, box.repo, { lane, title, route, run: setup,
      criterion: 'The item can be built and checked from its brief.', check: 'true', diagnose: false,
      brief: `Files: ${lane}/${route}-${title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')}.js\nChange: build the fixture item\nTest: the check proves the fixture`,
      args: ['--specs', lane === 'api' ? 'G2' : 'G1'] }).item_id;
  }
  /** Keep the test's queue order explicit without touching a production board. */
  function milestone(name, id) {
    json(setup(box.repo, 'milestone', 'add', name, '--items', String(id), '--reason', 'Arrange fixture release', '--json'));
  }
  /** Read the local checkout binding only; a session digest must never become board metadata. */
  function binding(root) {
    return JSON.parse(readFileSync(join(resolve(root, box.git(root, 'rev-parse', '--git-dir')), 'pullboard-checkout-session.json'), 'utf8'));
  }
  return { ...box, session, runAs, runAsLocal, json, seat, add, milestone, binding };
}
