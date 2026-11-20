/** @pullboard-world-pin: reads the root package.json bin entry to find the CLI test runner launcher the fixtures spawn [Q4,C7]. Fixtures for gate queue tests: private machine homes, probe suites and fixture gates, with no CLI launch and no hooks [Q4,C7]. */
import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from './child.js';
import { runFixtureChild as spawnSync } from './child.js';
import { runFixtureChild } from './child.js';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BROWSER_SLOT_HELD_ENV } from '../../../../packages/resources/index.js';
import { GATE_SLOT_HELD_ENV } from '../../../../packages/resources/index.js';
import { GATE_SLOT_POOL_ENV } from '../../../../packages/resources/index.js';
import { GATE_SLOT_TOKEN_ENV } from '../../../../packages/resources/index.js';
import { TEST_FILE_POOL_ENV } from '../../../../packages/gate/heavy.js';
import { executionServicesSource } from './execution.js';
import { fixtureProjectPolicy } from './testkit.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
/** The test runner launcher, found from the root package's `bin` so this fixture names no app path. */
export const RUNNER = resolve(ROOT, dirname(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).bin.pullboard), 'src/io/run/tests.js');
export const GATE_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/index.js')).href;
export const RESOURCE_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/resources/index.js')).href;
export const PROBE_NAME = 'machine gate slot runner probe [Q4]';
export const PROBE_PATTERN = '^machine gate slot runner probe \\[Q4\\]$';
export const PROBE_PATH_ENV = 'PULLBOARD_GATE_RESOURCE_PROBE_PATH';
export const PROBE_RELEASE_ENV = 'PULLBOARD_GATE_RESOURCE_PROBE_RELEASE';
const TEMP = [];
export const CHILDREN = new Set();

/** Kill every fixture process group still running, wait for each to close, and remove every private folder. */
export async function reapFixtures() {
  const running = [...CHILDREN];
  for (const child of running) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The fixture process already ended. */ }
  }
  await Promise.all(running.map((child) => child.closed));
  TEMP.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
}

/** Collect a detached fixture child's output and register it so reapFixtures can end it; resolves `closed` with its code and signal. */
export function trackChild(child) {
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { child.stdoutText += chunk; });
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  CHILDREN.add(child);
  child.closed = new Promise(resolveClose => child.once('close', (code, signal) => {
    CHILDREN.delete(child);
    resolveClose({ code, signal });
  }));
  return child;
}

/** Quote a fixture path for the gate shell command. */
export function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Create one private machine home, event file and isolated Git environment. */
export function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-gate-queue-')));
  TEMP.push(dir);
  const events = join(dir, 'events.log');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Queue Test',
    GIT_AUTHOR_EMAIL: 'queue@example.invalid',
    GIT_COMMITTER_NAME: 'Queue Test',
    GIT_COMMITTER_EMAIL: 'queue@example.invalid',
    PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'home'),
  };
  mkdirSync(env.PULLBOARD_MACHINE_HOME, { recursive: true });
  delete env[GATE_SLOT_HELD_ENV];
  // The runner this file runs on holds a token of its own run's file pool; whole-suite fixture runs need a pool of their own.
  delete env[TEST_FILE_POOL_ENV];
  for (const key of [GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV, 'PULLBOARD_TEST_ACTIONS', 'PULLBOARD_TEST_SELECTION', 'PULLBOARD_TEST_BROWSER_BY_LAUNCH', 'NODE_OPTIONS']) delete env[key];
  return { dir, events, env };
}

/** Commit a probe project's policy on main, so the runner's gate admission finds a trunk (NO_POLICY otherwise). */
function commitProbePolicy(box, root) {
  fixtureProjectPolicy(root);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'fixture']]) {
    assert.equal(runFixtureChild('git', args, { cwd: root, env: box.env, encoding: 'utf8' }).status, 0);
  }
}

/** Create a tiny test-project with one discoverable probe instead of recursively loading this repository's suite. */
export function probeSuite(box, name) {
  const root = join(box.dir, name);
  const tests = join(root, 'test');
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, 'probe.test.js'), `import { existsSync, renameSync, writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest(${JSON.stringify(PROBE_NAME)}, async () => {\n  const marker = process.env.${PROBE_PATH_ENV};\n  if (marker) {\n    const temporary = marker + '.tmp';\n    writeFileSync(temporary, process.env.${GATE_SLOT_HELD_ENV} ?? 'none');\n    renameSync(temporary, marker);\n  }\n  const release = process.env.${PROBE_RELEASE_ENV};\n  while (release && !existsSync(release)) await new Promise(done => setTimeout(done, 10));\n});\n`);
  commitProbePolicy(box, root);
  return root;
}

/** Launch a run-tests invocation with its own process group and captured output. */
export function launchTestRunner(box, root, args, marker, release, extraEnv = {}) {
  // Bare probes represent whole-suite gate runs, not seat tests that reserve a gate slot for item checks.
  const env = { ...box.env, ...(args.length === 0 ? { PULLBOARD_LANDING_RUN: '1' } : {}),
    [PROBE_PATH_ENV]: marker, ...(release ? { [PROBE_RELEASE_ENV]: release } : {}), ...extraEnv };
  delete env[GATE_SLOT_HELD_ENV];
  const child = spawn(process.execPath, [RUNNER, ...args], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { child.stdoutText += chunk; });
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  CHILDREN.add(child);
  child.closed = new Promise(resolveClose => child.once('close', (code, signal) => {
    CHILDREN.delete(child);
    resolveClose({ code, signal });
  }));
  return child;
}

/** Create a probe project whose one named test file records the gate lease it runs under, then waits for release. */
export function shortProbeSuite(box, name) {
  const root = join(box.dir, name);
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'test/short-probe.test.js'), `import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
test(${JSON.stringify(PROBE_NAME)}, async () => {
  const marker = process.env.${PROBE_PATH_ENV};
  if (marker) {
    writeFileSync(marker + '.tmp', JSON.stringify({ pool: process.env.${GATE_SLOT_POOL_ENV}, token: process.env.${GATE_SLOT_TOKEN_ENV} }));
    renameSync(marker + '.tmp', marker);
  }
  const release = process.env.${PROBE_RELEASE_ENV};
  while (release && !existsSync(release)) await new Promise(done => setTimeout(done, 10));
});
`);
  commitProbePolicy(box, root);
  return root;
}

/** Ask, from a child holding the given lease's markers, to reuse it for a run that does not name its files. */
export function wholeSuiteInheritance(box, root, lease) {
  const script = join(box.dir, 'whole-suite-inheritance.mjs');
  writeFileSync(script, `import { inheritedGateSlot } from ${JSON.stringify(RESOURCE_MODULE)};
try {
  inheritedGateSlot({ root: process.cwd() });
  process.stdout.write('inherited');
} catch (error) { process.stdout.write(String(error.code)); }
`);
  return spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { ...box.env, [GATE_SLOT_HELD_ENV]: '1',
    [GATE_SLOT_POOL_ENV]: lease.pool, [GATE_SLOT_TOKEN_ENV]: lease.token, [BROWSER_SLOT_HELD_ENV]: '' } });
}

/** Queue a plain gate lease that names no test files and needs no browser, like an opaque item check. */
export function launchOrdinaryLease(box, root, { marker, release, waiting }) {
  const script = join(box.dir, 'ordinary-lease.mjs');
  writeFileSync(script, `import { existsSync, writeFileSync } from 'node:fs';
import { withGateSlot } from ${JSON.stringify(GATE_MODULE)};
${executionServicesSource(GATE_MODULE)}
await withGateSlot(process.cwd(), async () => {
  writeFileSync(${JSON.stringify(marker)}, 'started');
  while (!existsSync(${JSON.stringify(release)})) await new Promise(done => setTimeout(done, 10));
}, { executionServices, kind: 'fixture-ordinary', onWait: () => writeFileSync(${JSON.stringify(waiting)}, 'waiting') });
`);
  const child = spawn(process.execPath, [script], { cwd: root, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { child.stdoutText += chunk; });
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  CHILDREN.add(child);
  child.closed = new Promise(resolveClose => child.once('close', (code, signal) => {
    CHILDREN.delete(child);
    resolveClose({ code, signal });
  }));
  return child;
}

/** Fill both gate slots with real whole-suite runs and wait until each one's probe is running. */
export async function wholeSuiteHolders(box, names, add = child => child) {
  const runs = names.map(name => {
    const marker = join(box.dir, `${name}.started`);
    const release = join(box.dir, `${name}.release`);
    return { marker, release, child: add(launchTestRunner(box, probeSuite(box, name), [], marker, release)) };
  });
  try { await waitFor(() => runs.every(run => existsSync(run.marker)), 'every gate slot to hold a whole-suite run'); } catch (error) {
    throw new Error(`${error.message}: ${runs.map(run => `${run.child.exitCode ?? 'running'} ${run.child.stdoutText}${run.child.stderrText}`).join(' | ').slice(0, 1500)}; home ${readdirSync(join(box.dir, 'home')).join(',')} settings ${readFileSync(join(box.dir, 'home', 'settings.json'), 'utf8')}`);
  }
  return runs;
}

/** Release every probe and wait for its runner, so a failed assertion leaves no fixture process behind. */
export async function releaseAll(runs) {
  for (const run of runs) writeFileSync(run.release, 'release\n');
  return Promise.all(runs.map(run => run.child.closed));
}

/** Create a clean gate repo whose start and end record observable execution, optionally waiting for a release file. */
export function gateRepo(box, name, delay = 0.25, releaseFile = null) {
  const root = join(box.dir, name);
  mkdirSync(root);
  const git = (...args) => runFixtureChild('git', args, { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(git('init', '-q', '-b', 'main').status, 0);
  const wait = releaseFile ? `while [ ! -e ${quote(releaseFile)} ]; do sleep 0.02; done` : `sleep ${delay}`;
  const command = `printf '${name} start\\n' >> ${quote(box.events)}; ${wait}; printf '${name} end\\n' >> ${quote(box.events)}`;
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: command }));
  writeFileSync(join(root, 'SPEC.md'), '# Queue fixture\n');
  assert.equal(git('add', '-A').status, 0);
  assert.equal(git('commit', '-q', '-m', 'chore: queue fixture').status, 0);
  return root;
}

/** Wait until an observable fixture state is reached, or fail with a useful timeout. */
export async function waitFor(predicate, description, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Read the current private event log. */
export function events(box) {
  return existsSync(box.events) ? readFileSync(box.events, 'utf8').trim().split(/\r?\n/u).filter(Boolean) : [];
}

export const PROBE_WRITE_TARGET_ENV = 'PULLBOARD_GATE_RESOURCE_WRITE_TARGET';
export const PROBE_WRITE_READY_ENV = 'PULLBOARD_GATE_RESOURCE_WRITE_READY';
export const PROBE_WRITE_RELEASE_ENV = 'PULLBOARD_GATE_RESOURCE_WRITE_RELEASE';
const CONFIG_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../config/index.js')).href;

/** The gate command's own engine in a fresh process: the repo's configured gate under the machine queue, printing the wait lines and report the command prints. */
export function gateRunScript(box) {
  const script = join(box.dir, 'gate-run.mjs');
  writeFileSync(script, `import { readFileSync } from 'node:fs';
import { runGate, gateReport, gateWaitReporter } from ${JSON.stringify(GATE_MODULE)};
${executionServicesSource(GATE_MODULE)}
const config = JSON.parse(readFileSync('pullboard.json', 'utf8'));
const say = line => console.log(line);
const gate = await runGate(process.cwd(), config, { executionServices, trustStamp: true, agent: 'coordinator', onWait: gateWaitReporter({ say }) });
say(gateReport(gate));
process.exitCode = gate.isGreen ? 0 : 1;
`);
  return script;
}

/** Launch the gate directly in its own process group and collect its output. */
export function launch(box, root) {
  return trackChild(spawn(process.execPath, [gateRunScript(box)], { cwd: root, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }));
}

/** Run the gate directly to completion and return its status and output. */
export function runGateSync(box, root) {
  return spawnSync(process.execPath, [gateRunScript(box)], { cwd: root, env: box.env, encoding: 'utf8' });
}

/** Set the machine gate capacity through the config cell's writer, as the settings command does; returns the written settings. */
export function setGateSlots(box, root, slots) {
  const script = join(box.dir, 'set-gate-slots.mjs');
  writeFileSync(script, `import { setGateSlots } from ${JSON.stringify(CONFIG_MODULE)};\nprocess.stdout.write(JSON.stringify(setGateSlots(Number(process.argv[2]))));\n`);
  const result = spawnSync(process.execPath, [script, String(slots)], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure ?? result.stderr);
  return JSON.parse(result.stdout);
}

/** Set the fixture machine pool to one gate slot before starting holders. */
export function setOneGateSlot(box, root) {
  assert.equal(setGateSlots(box, root, 1).gateSlots, 1);
}

/** Launch a real process that holds the production diagnostic resource class until released. */
export function launchDiagnostic(box, root, name, started, release, waiting) {
  const script = join(box.dir, `${name}.mjs`);
  writeFileSync(script, `import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { withGateSlot } from ${JSON.stringify(GATE_MODULE)};
${executionServicesSource(GATE_MODULE)}
/** Publish a complete handshake so its visible file always contains its value. */
function publish(file, value) { writeFileSync(file + '.tmp', value); renameSync(file + '.tmp', file); }
await withGateSlot(process.cwd(), async () => {
  publish(${JSON.stringify(started)}, 'started');
  while (!existsSync(${JSON.stringify(release)})) await new Promise(done => setTimeout(done, 10));
}, { executionServices, diagnostic: true, kind: 'main-red', agent: ${JSON.stringify(name)}, onWait: state => publish(${JSON.stringify(waiting)}, String(state.position)) });
`);
  const child = spawn(process.execPath, [script], { cwd: root, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { child.stdoutText += chunk; });
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  CHILDREN.add(child);
  child.closed = new Promise(resolveClose => child.once('close', (code, signal) => {
    CHILDREN.delete(child);
    resolveClose({ code, signal });
  }));
  return child;
}
