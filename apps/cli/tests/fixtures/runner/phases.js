import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import { roundTripLine } from '../../../../../packages/runners/index.js';
import { roundTripProfile } from '../../../../../packages/runners/index.js';
import { runOnRunnerAsync } from '../../../../../packages/runners/index.js';
import { copyRunnerPackage } from '../../../../../packages/runners/tests/fixtures/package.js';
/** Pure registered-runner test helpers: snapshots, phase counting and bounded round-trip waits; nothing here launches the CLI. */
import { executionServicesSource } from '../gate/execution.js';
import { awaitNestedRun } from '../../../../../packages/gate/heavy.js';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  join,
  resolve,
} from 'node:path';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { loadavg } from 'node:os';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  runFixtureChild,
  runFixtureChildAsync,
} from '../child.js';
import { stopGroup } from './group.js';
import { HOST } from './ssh.js';
import { installSshStandIn } from './ssh.js';
import { privateFixtureFiles } from '../child.js';
import { fixtureCommittedGraph } from '../testkit.js';

export const TOOLING_SNAPSHOTS = new Map();
export const ROUND_TRIP_DEADLINES = { dispatch: 45_000, 'remote run': 30_000, 'result return': 30_000 }; // budget: a stuck runner fails by name in about a minute, far under the 660-second per-test limit; dispatch took 20 s and result return 10 s on runners at twice their cores.

/** Run Git in the private source repository and preserve useful failure context. */
export function git(repo, env, ...args) {
  const result = runFixtureChild('git', args, { cwd: repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  return result.stdout.trim();
}

/** Copy current tooling bytes into a private committed checkout for runner source validation. */
export function committedToolingSnapshot(sourceRoot, env) {
  const key = realpathSync(sourceRoot);
  const cached = TOOLING_SNAPSHOTS.get(key);
  if (cached) return cached.root;
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-runner-tooling-'));
  const root = join(directory, 'tooling');
  const home = join(directory, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  try {
    copyPackageFiles(key, root);
    const gitEnv = { ...env, HOME: home, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(home, '.pullboard'),
      PULLBOARD_MACHINE_HOME: join(home, '.pullboard'), GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
      GIT_AUTHOR_NAME: 'Runner Tooling Fixture', GIT_AUTHOR_EMAIL: 'runner-tooling@example.invalid',
      GIT_COMMITTER_NAME: 'Runner Tooling Fixture', GIT_COMMITTER_EMAIL: 'runner-tooling@example.invalid' };
    for (const key of ['GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete gitEnv[key];
    git(root, gitEnv, 'init', '-q', '-b', 'main');
    git(root, gitEnv, 'add', '.');
    git(root, gitEnv, 'commit', '-q', '-m', 'test: snapshot current runner tooling');
  } catch (error) {
    process.stderr.write(`retained incomplete runner tooling snapshot at ${directory}: ${error.message}\n`);
    throw error;
  }
  TOOLING_SNAPSHOTS.set(key, { root, directory, active: 0, retained: false });
  return root;
}

/** Clean retained tooling copies after fixture children have stopped. */
export function cleanupToolingSnapshots() {
  for (const record of TOOLING_SNAPSHOTS.values()) {
    if (record.active || record.retained) {
      process.stderr.write(`retained runner tooling snapshot at ${record.directory}\n`);
      continue;
    }
    rmSync(record.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  TOOLING_SNAPSHOTS.clear();
}

/** Count the stand-in's phase markers; a missing file means nothing was dispatched yet. */
export function phaseCounts(file) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  return { dispatched: lines.filter(line => line === 'dispatched').length, returned: lines.filter(line => line === 'returned').length };
}

/**
 * Wait for a runner round trip phase by phase: dispatch (until the stand-in is reached), remote run
 * (until the worker returns) and result return (until the controller exits). A phase past its
 * deadline stops the whole controller group and throws an error naming that phase, so a stuck
 * runner fails the test in about a minute instead of holding it to the per-test limit. The caller
 * passes the marker counts it read before spawning the child: a fast child can dispatch before this
 * function first runs, and a baseline read here would swallow that dispatch.
 */
export function awaitRoundTrip(child, closed, phasesFile, before, deadlines = ROUND_TRIP_DEADLINES, firstReceiptAccepted = null) {
  const terminal = monitorRoundTrip(child, closed, phasesFile, before, deadlines, firstReceiptAccepted).catch(async error => {
    if (child.exitCode === null && child.signalCode === null) await stopGroup(child, closed);
    throw error;
  });
  terminal.child = child;
  return awaitNestedRun(terminal);
}

/** Monitor the owned child's progress and cancellation inside its single explicit yielding wait. */
async function monitorRoundTrip(child, closed, phasesFile, before, deadlines, firstReceiptAccepted) {
  // A phase left at its default deadline is charged for machine load, so a loaded runner is not mistaken for a stuck one.
  const scale = Math.min(6, Math.max(1, loadavg()[0] / Math.max(1, cpus().length)));
  const limits = Object.fromEntries(Object.entries(ROUND_TRIP_DEADLINES).map(([name, ms]) =>
    [name, deadlines === ROUND_TRIP_DEADLINES || deadlines?.[name] === undefined ? Math.round(ms * scale) : deadlines[name]]));
  let done = null;
  closed.then(result => { done = result; });
  const timings = [];
  // The marker file may already hold earlier round trips of the same fixture; count only this one.
  assert.ok(!phasesFile || before, 'awaitRoundTrip needs the phase baseline read before the child was spawned');
  let phase = 'dispatch';
  let phaseStarted = Date.now();
  let observed = { dispatched: 0, returned: 0 };
  while (!done) {
    const total = phasesFile ? phaseCounts(phasesFile) : { dispatched: 0, returned: 0 };
    const counts = phasesFile ? { dispatched: total.dispatched - before.dispatched, returned: total.returned - before.returned } : total;
    // The observer saves the accepted first receipt before preparing its paired dispatch. That real
    // controller-side witness ends result delivery; a worker's "returned" marker alone cannot do so.
    const redispatch = counts.dispatched === 1 && counts.returned === 1 && firstReceiptAccepted?.();
    const next = redispatch ? 'dispatch' : counts.dispatched > counts.returned ? 'remote run' : counts.dispatched > 0 ? 'result return' : 'dispatch';
    // A returned attempt and its paired dispatch can arrive in one poll without changing the phase's name.
    // Each real marker advance starts a fresh clock, while a phase with no new marker remains bounded.
    if (next !== phase || counts.dispatched > observed.dispatched || counts.returned > observed.returned) {
      timings.push(`${phase} ${Date.now() - phaseStarted}ms (attempt ${observed.dispatched})`);
      phase = next;
      phaseStarted = Date.now();
      observed = counts;
    }
    const spent = Date.now() - phaseStarted;
    if (spent > limits[phase]) {
      await stopGroup(child, closed);
      throw new Error(`runner round trip stuck in phase "${phase}": no progress after ${spent} ms (deadline ${limits[phase]} ms); earlier phases: ${timings.join(', ') || 'none'}\n${fixtureResultContext(done ?? {})}`);
    }
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 50))]); // budget: polling interval for the stand-in's phase markers.
  }
  timings.push(`${phase} ${Date.now() - phaseStarted}ms`);
  process.stderr.write(`runner round trip phases: ${timings.join(', ')}\n`);
  return done;
}

/**
 * Run a gate command through its real lease and return the profile/result emitted by the API child.
 * `requests` names the stand-in's request log, whose .phases file times the round trip by phase.
 */
export async function runThroughGate(repo, env, command, { browser = true, timing = false, item = '663', kind = 'check', landing = false, toolingRoot = resolve(import.meta.dirname, '../../../../..'), requests, deadlines } = {}) {
  const sourceRoot = realpathSync(toolingRoot);
  const gateUrl = pathToFileURL(join(committedToolingSnapshot(sourceRoot, env), 'packages', 'gate', 'index.js')).href;
  const snapshot = TOOLING_SNAPSHOTS.get(sourceRoot);
  snapshot.active++;
  const script = `const { runProfiledShellAsync, withGateSlot } = await import(${JSON.stringify(gateUrl)});
${executionServicesSource(gateUrl)}
const result = await withGateSlot(${JSON.stringify(repo)}, lease => runProfiledShellAsync(${JSON.stringify(repo)}, ${JSON.stringify(command)}, { gateLease: lease, landing: ${landing} }),
  { executionServices, browser: ${browser}, timing: ${timing}, item: ${JSON.stringify(item)}, kind: ${JSON.stringify(kind)}, landing: ${landing}, agent: 'runner-fixture' });
process.stdout.write(result.output);
process.stdout.write('PULLBOARD_RUN_RESULT ' + JSON.stringify({ isGreen: result.isGreen, runner: result.profile.executionRunner, sandboxBlocked: result.sandboxBlocked, profile: result.profile }) + '\\n');
process.exitCode = result.isGreen ? 0 : 1;
`;
  try {
    // Read the phase baseline before spawning, so a dispatch that beats the first poll still counts.
    const phases = requests ? `${requests}.phases` : '';
    const before = phases ? phaseCounts(phases) : null;
    // Its own process group, so a stuck phase can stop the controller, the stand-in and the worker together.
    const closed = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, env, detached: true });
    const result = await awaitRoundTrip(closed.child, closed, phases, before, deadlines);
    if (result.status !== 0) snapshot.retained = true;
    return result;
  } catch (error) {
    snapshot.retained = true;
    throw error;
  } finally { snapshot.active--; }
}

/** Parse the bounded final API line without rewriting the command's raw TAP output. */
export function gateResult(stdout) {
  const line = stdout.split(/\r?\n/u).findLast(value => value.startsWith('PULLBOARD_RUN_RESULT '));
  assert.ok(line, stdout);
  return JSON.parse(line.slice('PULLBOARD_RUN_RESULT '.length));
}

/** Include bounded command output when a remote fixture assertion fails. */
export function fixtureResultContext(result) {
  return `${result.context}\nstdout tail:\n${String(result.stdout ?? '').slice(-4_000)}\nstderr tail:\n${String(result.stderr ?? '').slice(-4_000)}`;
}

/**
 * Start `count` CPU-bound jobs beside the fixture runner, whose host is this machine, and return a stop that waits for
 * each to exit. Why: a gate sends its shards to one runner at once, and a round trip must stay cheap beside them (#8145).
 */
export function otherJobs(count) {
  const jobs = Array.from({ length: count }, () => spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
  const exits = jobs.map(job => new Promise(resolve => { if (job.exitCode !== null || job.signalCode !== null) resolve(); else job.once('exit', resolve); }));
  return async () => { for (const job of jobs) job.kill('SIGKILL'); await Promise.all(exits); };
}

/**
 * Run `count` round trips of one committed tree on one fixture runner, under a private controller home, and return
 * each trip's phase profile with its printed line; the first trip really runs the test body on the runner.
 */
export async function profiledRoundTrips(t, count, { otherJobs: busy = 0 } = {}) {
  const directory = privateFixtureFiles('pullboard-round-trip-').root;
  const graph = fixtureCommittedGraph('pullboard-round-trip-repo-'), repo = graph.root;
  t.after(() => { rmSync(directory, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });
  const [bin, worker, controller, home] = ['bin', 'worker', 'controller', 'machine'].map(name => join(directory, name));
  for (const folder of [bin, worker, controller, home]) mkdirSync(folder, { recursive: true });
  copyRunnerPackage(resolve(import.meta.dirname, '../../../../..'), repo);
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ ...manifest, name: 'round-trip-fixture', private: true, type: 'module' }) + '\n');
  graph.put('test/probe.test.js', "import { test } from 'node:test';\ntest('round trip probe [C7]', () => { console.log('EXECUTED-ROUND-TRIP'); });\n");
  const trunk = { ref: 'refs/heads/main', commit: graph.commit() };
  const env = { HOME: controller, PULLBOARD_HOME: controller, PULLBOARD_MACHINE_HOME: join(controller, '.pullboard'), PATH: `${bin}${delimiter}${process.env.PATH}` };
  const previous = Object.fromEntries([...Object.keys(env), 'PULLBOARD_TEST_REUSE'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, env);
  delete process.env.PULLBOARD_TEST_REUSE;
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests: join(home, 'requests.jsonl'), nodeCommand: process.execPath });
  const profiles = [];
  for (let index = 0; index < count; index++) {
    // Repeats run beside the other jobs; the first trip stays alone so its cold export fits the case's timeout.
    const stop = index > 0 && busy ? otherJobs(busy) : null;
    if (stop) t.after(stop);
    const result = await runOnRunnerAsync(repo, 'node apps/cli/src/io/run/tests.js test/probe.test.js', {
      runner: { host: HOST, slots: 1, browser: 0, node: process.execPath, root: join(home, 'runner') }, metadata: { item: 'fixture', kind: 'remote-command', testStage: 'submit', trunk } });
    await stop?.();
    assert.equal(result.isGreen, true, result.output);
    // A repeat may reuse the first trip's receipt, as a real gate would; the first must run the body.
    if (index === 0) assert.match(result.output, /EXECUTED-ROUND-TRIP/u, 'the runner really runs the test body');
    const profile = roundTripProfile(result.phases), line = roundTripLine(profile);
    t.diagnostic(line);
    profiles.push({ ...profile, line });
  }
  return profiles;
}
