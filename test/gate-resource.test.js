/** @pullboard-test-loads src/browser-admission.js */
/** Real gates and item checks share the machine queue; landing priority and lease behavior stay intact [Q1,Q2,Q4,O5,O6,V18]. */
import { executionServicesSource } from './gate-execution-fixture.js';
import assert from 'node:assert/strict';
import { startFixtureChild as spawn, runFixtureChild as spawnSync, runFixtureChild } from './fixture-child.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { BROWSER_SLOT_HELD_ENV, GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV } from '../src/resources.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const RUNNER = resolve(import.meta.dirname, '../bin/run-tests.js');
const GATE_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/gate.js')).href;
const RESOURCE_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/resources.js')).href;
const BROWSER_ADMISSION_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/browser-admission.js')).href;
const PROBE_NAME = 'machine gate slot runner probe [Q4]';
const PROBE_PATTERN = '^machine gate slot runner probe \\[Q4\\]$';
const PROBE_PATH_ENV = 'PULLBOARD_GATE_RESOURCE_PROBE_PATH';
const PROBE_RELEASE_ENV = 'PULLBOARD_GATE_RESOURCE_PROBE_RELEASE';
const PROBE_WRITE_TARGET_ENV = 'PULLBOARD_GATE_RESOURCE_WRITE_TARGET';
const PROBE_WRITE_READY_ENV = 'PULLBOARD_GATE_RESOURCE_WRITE_READY';
const PROBE_WRITE_RELEASE_ENV = 'PULLBOARD_GATE_RESOURCE_WRITE_RELEASE';
const TEMP = [];
const CHILDREN = new Set();

/** Quote a fixture path for the gate shell command. */
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Create one private machine home, event file and isolated Git environment. */
function fixture() {
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
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'home'),
  };
  delete env[GATE_SLOT_HELD_ENV];
  return { dir, events, env };
}

/** Create a tiny test-project with one discoverable probe instead of recursively loading this repository's suite. */
function probeSuite(box, name) {
  const root = join(box.dir, name);
  const tests = join(root, 'test');
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, 'probe.test.js'), `import { existsSync, renameSync, writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest(${JSON.stringify(PROBE_NAME)}, async () => {\n  const marker = process.env.${PROBE_PATH_ENV};\n  if (marker) {\n    const temporary = marker + '.tmp';\n    writeFileSync(temporary, process.env.${GATE_SLOT_HELD_ENV} ?? 'none');\n    renameSync(temporary, marker);\n  }\n  const release = process.env.${PROBE_RELEASE_ENV};\n  while (release && !existsSync(release)) await new Promise(done => setTimeout(done, 10));\n});\n`);
  return root;
}

/** Launch a run-tests invocation with its own process group and captured output. */
function launchTestRunner(box, root, args, marker, release, extraEnv = {}) {
  const env = { ...box.env, [PROBE_PATH_ENV]: marker, ...(release ? { [PROBE_RELEASE_ENV]: release } : {}), ...extraEnv };
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

/** Launch a real process that holds the production diagnostic resource class until released. */
function launchDiagnostic(box, root, name, started, release, waiting) {
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

/** Create a probe project whose one named test file records the gate lease it runs under, then waits for release. */
function shortProbeSuite(box, name) {
  const root = join(box.dir, name);
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'test', 'short-probe.test.js'), `import { existsSync, renameSync, writeFileSync } from 'node:fs';
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
  return root;
}

/** Ask, from a child holding the given lease's markers, to reuse it for a run that does not name its files. */
function wholeSuiteInheritance(box, root, lease) {
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
function launchOrdinaryLease(box, root, { marker, release, waiting }) {
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

/** Run one pullboard command in a fixture, require success, and return its output. */
function pullboard(box, root, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.failure ?? ''}${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** Fill both gate slots with real whole-suite runs and wait until each one's probe is running. */
async function wholeSuiteHolders(box, names) {
  const runs = names.map(name => {
    const marker = join(box.dir, `${name}.started`);
    const release = join(box.dir, `${name}.release`);
    return { marker, release, child: launchTestRunner(box, probeSuite(box, name), [], marker, release) };
  });
  await waitFor(() => runs.every(run => existsSync(run.marker)), 'every gate slot to hold a whole-suite run');
  return runs;
}

/** Release every probe and wait for its runner, so a failed assertion leaves no fixture process behind. */
async function releaseAll(runs) {
  for (const run of runs) writeFileSync(run.release, 'release\n');
  return Promise.all(runs.map(run => run.child.closed));
}

/** Create a clean gate repo whose start and end record observable execution, optionally waiting for a release file. */
function gateRepo(box, name, delay = 0.25, releaseFile = null) {
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

/** Launch a real gate CLI in its own process group and collect its output. */
function launch(box, root, args = ['gate']) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: root, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { child.stdoutText += chunk; });
  child.stderr.on('data', (chunk) => { child.stderrText += chunk; });
  CHILDREN.add(child);
  child.closed = new Promise((resolveClose) => child.once('close', (code, signal) => {
    CHILDREN.delete(child);
    resolveClose({ code, signal });
  }));
  return child;
}

/** Create a real claimed item whose check can pause after admission and leave an execution marker. */
function checkProject(box, { releaseCheck = null } = {}) {
  const root = join(box.dir, 'check-project');
  const runner = join(box.dir, 'check-runner');
  const script = join(box.dir, 'item-check.cjs');
  const shims = join(box.dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  box.env.PATH = `${shims}:${box.env.PATH}`;
  mkdirSync(root);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: box.env }).status, 0);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({
    gate: 'true',
    lanes: { web: { owns: ['web/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } },
  }));
  writeFileSync(join(root, 'SPEC.md'), '# Queue fixture\n\n## G · Goals\n- G1 [approved, must] The check runs. | gate: test -f web/result.txt\n- G2 [approved, must] The API responds. | gate: test -f api/result.txt\n');
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root, env: box.env }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'chore: queue fixture'], { cwd: root, env: box.env }).status, 0);
  const initialized = spawnSync(process.execPath, [BIN, 'init'], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(spawnSync('git', ['worktree', 'add', '-q', runner, '-b', 'web/runner'], { cwd: root, env: box.env }).status, 0);
  const joined = spawnSync(process.execPath, [BIN, 'join', 'web'], { cwd: runner, env: box.env, encoding: 'utf8' });
  assert.equal(joined.status, 0, joined.stderr);
  writeFileSync(script, releaseCheck
    ? `const fs = require('node:fs');\n(async () => {\n  fs.appendFileSync(${JSON.stringify(box.events)}, 'item check start\\n');\n  while (!fs.existsSync(${JSON.stringify(releaseCheck)})) await new Promise(done => setTimeout(done, 10));\n  fs.appendFileSync(${JSON.stringify(box.events)}, 'item check\\n');\n  process.exitCode = fs.existsSync('web/result.txt') ? 0 : 1;\n})();\n`
    : `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(box.events)}, 'item check\\n'); process.exitCode = fs.existsSync('web/result.txt') ? 0 : 1;\n`);
  if (releaseCheck) writeFileSync(releaseCheck, 'baseline runs without a hold\n');
  const added = spawnSync(process.execPath, [BIN, 'add', 'web', 'Check item', '--specs', 'G1', '--route', 'light', '--criterion', 'the item check runs', '--check', `node '${script}'`, '--wait', '--brief', 'Files: web/result.txt\nTest: run the item check and observe its result.'], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(spawnSync(process.execPath, [BIN, 'claim', '1'], { cwd: runner, env: box.env }).status, 0);
  if (releaseCheck) rmSync(releaseCheck, { force: true });
  writeFileSync(box.events, '');
  return { root, runner };
}

/** Set the fixture machine pool to one gate slot before starting holders. */
function setOneGateSlot(box, root) {
  const configured = spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(configured.status, 0, configured.failure ?? configured.stderr);
}

/** Wait until an observable fixture state is reached, or fail with a useful timeout. */
async function waitFor(predicate, description, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Read the current private event log. */
function events(box) {
  return existsSync(box.events) ? readFileSync(box.events, 'utf8').trim().split(/\r?\n/u).filter(Boolean) : [];
}

after(async () => {
  const running = [...CHILDREN];
  for (const child of running) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The fixture process already ended. */ }
  }
  await Promise.all(running.map((child) => child.closed));
  TEMP.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

test('[Q4,O5,O6] gate processes run one at a time in FIFO order when machine slots are one', async () => {
  const box = fixture();
  const releaseFirst = join(box.dir, 'release-first');
  const roots = ['first', 'second', 'third'].map((name) => gateRepo(box, name, name === 'first' ? 0.1 : 0.2, name === 'first' ? releaseFirst : null));
  const setting = spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1', '--json'], { cwd: roots[0], env: box.env, encoding: 'utf8' });
  assert.equal(setting.status, 0, setting.stderr);
  assert.equal(JSON.parse(setting.stdout).settings.gateSlots, 1);
  const first = launch(box, roots[0]);
  await waitFor(() => events(box).includes('first start') && !events(box).includes('first end'), 'first gate to remain active', 30_000); // budget: hang ceiling for the private first-gate marker handshake; no throughput claim.
  const second = launch(box, roots[1]);
  await waitFor(() => second.stdoutText.includes('place 1'), 'second gate to enter the FIFO line');
  assert.match(second.stdoutText, /1 running/);
  assert.ok(second.stdoutText.includes(roots[0]), 'wait report names the repo holding the slot');
  const third = launch(box, roots[2]);
  await waitFor(() => third.stdoutText.includes('place 2'), 'third gate to enter behind the second');
  assert.ok(events(box).includes('first start') && !events(box).includes('first end'), 'both successors queued while the first gate still held its slot');
  writeFileSync(releaseFirst, 'release\n');
  const results = await Promise.all([first.closed, second.closed, third.closed]);
  assert.deepEqual(results.map(({ code }) => code), [0, 0, 0], `${first.stderrText}${second.stderrText}${third.stderrText}`);
  const starts = events(box).filter((line) => line.endsWith(' start')).map((line) => line.split(' ')[0]);
  assert.deepEqual(starts, ['first', 'second', 'third']);
  let running = 0;
  let maximum = 0;
  for (const line of events(box)) {
    if (line.endsWith(' start')) running += 1;
    else running -= 1;
    maximum = Math.max(maximum, running);
  }
  assert.equal(maximum, 1);
});

test('[Q4] gates with different PULLBOARD_HOME values share the machine pool unless explicitly separated', async () => {
  const shared = fixture();
  const releaseShared = join(shared.dir, 'release-shared');
  const firstRoot = gateRepo(shared, 'shared-first', 0, releaseShared);
  const otherBoardHome = { ...shared, env: { ...shared.env, PULLBOARD_HOME: join(shared.dir, 'other-board-home') } };
  const secondRoot = gateRepo(otherBoardHome, 'shared-second', 0, releaseShared);
  const setting = spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: firstRoot, env: shared.env, encoding: 'utf8' });
  assert.equal(setting.status, 0, setting.stderr);
  const first = launch(shared, firstRoot);
  let second;
  try {
    await waitFor(() => events(shared).includes('shared-first start'), 'first shared-pool gate to start');
    second = launch(otherBoardHome, secondRoot);
    await waitFor(
      () => second.stdoutText.includes('place 1') || events(shared).includes('shared-second start'),
      'gate with another board home to queue or start on the shared machine pool',
    );
    assert.ok(second.stdoutText.includes('place 1'), 'the other board home is queued behind the first gate');
    assert.deepEqual(events(shared), ['shared-first start']);
    writeFileSync(releaseShared, 'release');
    const results = await Promise.all([first.closed, second.closed]);
    assert.deepEqual(results.map(({ code }) => code), [0, 0], `${first.stderrText}${second.stderrText}`);
    assert.deepEqual(events(shared), ['shared-first start', 'shared-first end', 'shared-second start', 'shared-second end']);
  } finally {
    writeFileSync(releaseShared, 'release');
    await Promise.all([first, second].filter(Boolean).map((child) => child.closed));
  }

  const separated = fixture();
  const releaseSeparated = join(separated.dir, 'release-separated');
  const firstPool = { ...separated, env: { ...separated.env, PULLBOARD_MACHINE_HOME: join(separated.dir, 'machine-first') } };
  const secondPool = {
    ...separated,
    env: {
      ...separated.env,
      PULLBOARD_MACHINE_HOME: join(separated.dir, 'machine-second'),
    },
  };
  const isolatedFirstRoot = gateRepo(firstPool, 'isolated-first', 0, releaseSeparated);
  const isolatedSecondRoot = gateRepo(secondPool, 'isolated-second', 0, releaseSeparated);
  for (const [box, root] of [[firstPool, isolatedFirstRoot], [secondPool, isolatedSecondRoot]]) {
    const configured = spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: root, env: box.env, encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr);
  }
  const isolatedFirst = launch(firstPool, isolatedFirstRoot);
  let isolatedSecond;
  try {
    await waitFor(() => events(separated).includes('isolated-first start'), 'first isolated-pool gate to start');
    isolatedSecond = launch(secondPool, isolatedSecondRoot);
    await waitFor(() => events(separated).includes('isolated-second start'), 'explicit private pool to acquire while the first pool is occupied');
    assert.deepEqual(events(separated), ['isolated-first start', 'isolated-second start']);
    writeFileSync(releaseSeparated, 'release');
    const results = await Promise.all([isolatedFirst.closed, isolatedSecond.closed]);
    assert.deepEqual(results.map(({ code }) => code), [0, 0], `${isolatedFirst.stderrText}${isolatedSecond.stderrText}`);
    assert.deepEqual(events(separated).slice(0, 2), ['isolated-first start', 'isolated-second start']);
    assert.deepEqual(events(separated).slice(2).sort(), ['isolated-first end', 'isolated-second end']);
  } finally {
    writeFileSync(releaseSeparated, 'release');
    await Promise.all([isolatedFirst, isolatedSecond].filter(Boolean).map((child) => child.closed));
  }
});

test('[Q4] an exact-tree cached gate starts while another machine gate holds the only slot', async () => {
  const box = fixture();
  const cachedRoot = gateRepo(box, 'cached', 0.1);
  const releaseHolder = join(box.dir, 'release-holder');
  const holderRoot = gateRepo(box, 'holder', 0.1, releaseHolder);
  assert.equal(spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: holderRoot, env: box.env }).status, 0);
  const warm = spawnSync(process.execPath, [BIN, 'gate'], { cwd: cachedRoot, env: box.env, encoding: 'utf8' });
  assert.equal(warm.status, 0, warm.stderr);
  const priorCount = events(box).filter((line) => line.startsWith('cached ')).length;
  const holder = launch(box, holderRoot);
  await waitFor(() => events(box).includes('holder start') && !events(box).includes('holder end'), 'uncached holder gate to remain active', 30_000); // budget: hang ceiling for the private holder-gate marker handshake; no throughput claim.
  // A busy equal-capacity write is a no-op; raising capacity is now allowed by #778.
  const unchangedCapacity = spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1', '--json'], { cwd: cachedRoot, env: box.env, encoding: 'utf8' });
  assert.equal(unchangedCapacity.status, 0, unchangedCapacity.stderr);
  assert.equal(JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8')).gateSlots, 1);
  const cached = runFixtureChild(process.execPath, [BIN, 'gate'], { cwd: cachedRoot, env: box.env, encoding: 'utf8' });
  assert.equal(cached.status, 0, cached.stderr);
  assert.match(cached.stdout, /already passed/);
  assert.ok(events(box).includes('holder start') && !events(box).includes('holder end'), 'cached gate returned while the other machine gate still held its slot');
  assert.equal(events(box).filter((line) => line.startsWith('cached ')).length, priorCount, 'cached gate command did not run again');
  writeFileSync(releaseHolder, 'release\n');
  assert.equal((await holder.closed).code, 0, holder.stderrText);
  assert.ok(events(box).includes('holder end'), 'the holder exits only after the test releases it');
});

test('[Q4] SIGKILL during a gate releases its machine slot for the next process', async () => {
  const box = fixture();
  const deadRoot = gateRepo(box, 'dead', 20);
  const nextRoot = gateRepo(box, 'next', 0.1);
  assert.equal(spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: deadRoot, env: box.env }).status, 0);
  const dead = launch(box, deadRoot);
  await waitFor(() => events(box).includes('dead start'), 'gate to hold a slot before it is killed');
  const next = launch(box, nextRoot);
  await waitFor(() => next.stdoutText.includes('place 1'), 'successor gate to queue');
  process.kill(-dead.pid, 'SIGKILL');
  assert.equal((await dead.closed).signal, 'SIGKILL');
  const result = await Promise.race([
    next.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('successor did not acquire the freed slot')), 5_000)), // budget: hang ceiling for a freed slot acquisition; no throughput claim.
  ]);
  assert.equal(result.code, 0, next.stderrText);
  assert.ok(events(box).includes('next start'));
});

test('[Q1,Q2,V18] an older item check keeps its place ahead of a later ordinary gate', async () => {
  const box = fixture();
  const release = join(box.dir, 'release-holder');
  const checkRelease = join(box.dir, 'release-item-check');
  const firstRoot = gateRepo(box, 'slot-holder', 0.1, release);
  const nextRoot = gateRepo(box, 'ordinary-gate', 0.15);
  const { root, runner } = checkProject(box, { releaseCheck: checkRelease });
  assert.equal(spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: firstRoot, env: box.env }).status, 0);

  const first = launch(box, firstRoot);
  await waitFor(() => events(box).includes('slot-holder start') && !events(box).includes('slot-holder end'), 'the first gate to hold the only slot');
  const check = launch(box, runner, ['check', '1', '--yes']);
  await waitFor(() => check.stdoutText.includes('place 1') || check.exitCode !== null, 'the item check to queue behind the running gate');
  assert.ok(check.stdoutText.includes('place 1'), 'the item check prints its queued gate-slot position');
  assert.match(check.stdoutText, /gate waiting:/);
  assert.deepEqual(events(box), ['slot-holder start'], 'the item check command has not started while the gate holds the slot');
  const ordinary = launch(box, nextRoot);
  await waitFor(() => /place [12]/u.test(ordinary.stdoutText), 'the later ordinary gate to enter the queue');
  assert.ok(ordinary.stdoutText.includes('place 2'), 'the later ordinary gate stays second behind the item check');
  assert.deepEqual(events(box), ['slot-holder start'], 'neither queued command runs before the holder releases');

  writeFileSync(release, 'release\n');
  await waitFor(() => events(box).includes('item check start'), 'the older item check to acquire the released slot');
  assert.equal(events(box).includes('ordinary-gate start'), false, 'the later ordinary gate stays behind the older item check');
  writeFileSync(checkRelease, 'release\n');
  await waitFor(() => events(box).includes('item check'), 'the older item check to release its slot');
  await waitFor(() => events(box).includes('ordinary-gate start'), 'the later ordinary gate to acquire after the item check');
  await waitFor(() => events(box).includes('ordinary-gate end'), 'the ordinary gate to finish');
  const [firstResult, ordinaryResult, checkResult] = await Promise.all([first.closed, ordinary.closed, check.closed]);
  assert.equal(firstResult.code, 0);
  assert.equal(ordinaryResult.code, 0, ordinary.stderrText);
  assert.equal(checkResult.code, 1, check.stderrText);
  assert.deepEqual(events(box), ['slot-holder start', 'slot-holder end', 'item check start', 'item check', 'ordinary-gate start', 'ordinary-gate end']);

  mkdirSync(join(runner, 'web'));
  writeFileSync(join(runner, 'web', 'result.txt'), 'ready\n');
  assert.equal(spawnSync('git', ['add', 'web/result.txt'], { cwd: runner, env: box.env }).status, 0);
  const commit = spawnSync('git', ['commit', '-q', '-m', 'feat(web): queue item proof [G1]'], { cwd: runner, env: box.env, encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  const submitted = spawnSync(process.execPath, [BIN, 'submit', '1'], { cwd: runner, env: box.env, encoding: 'utf8' });
  assert.equal(submitted.status, 0, submitted.stderr);
  rmSync(checkRelease, { force: true });
  const review = join(box.dir, 'check-review');
  const itemCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: runner, env: box.env, encoding: 'utf8' }).stdout.trim();
  assert.equal(spawnSync('git', ['worktree', 'add', '-q', '--detach', review, itemCommit], { cwd: root, env: box.env }).status, 0);
  const reviewer = spawnSync(process.execPath, [BIN, 'join', 'api'], { cwd: review, env: box.env, encoding: 'utf8' });
  assert.equal(reviewer.status, 0, reviewer.stderr);

  writeFileSync(box.events, '');
  const verifyRelease = join(box.dir, 'release-verify-holder');
  const verifyHolderRoot = gateRepo(box, 'verify-holder', 0.1, verifyRelease);
  const verifyFocusedRoot = probeSuite(box, 'verify-focused-suite');
  const verifyFocusedMarker = join(box.dir, 'verify-focused.started');
  const verifyFocusedRelease = join(box.dir, 'release-verify-focused');
  const verifyHolder = launch(box, verifyHolderRoot);
  await waitFor(() => events(box).includes('verify-holder start') && !events(box).includes('verify-holder end'), 'a gate to hold the slot before accepting an item');
  const verify = launch(box, review, ['verify', '1', 'accept', '--note', 'queue fixture']);
  await waitFor(() => verify.stdoutText.includes('place 1') || verify.exitCode !== null, 'verify accept to queue for the gate slot');
  assert.ok(verify.stdoutText.includes('place 1'), 'verify accept prints its queued gate-slot position');
  assert.match(verify.stdoutText, /gate waiting:/);
  const verifyNext = launchTestRunner(box, verifyFocusedRoot, ['--test-name-pattern', PROBE_PATTERN, 'test/probe.test.js'], verifyFocusedMarker, verifyFocusedRelease);
  await waitFor(() => /waiting for a gate slot:/u.test(verifyNext.stderrText) || verifyNext.exitCode !== null, 'the later focused run to enter the queue');
  assert.equal(existsSync(verifyFocusedMarker), false, 'the focused run has not started while the holder owns the slot');
  assert.equal(events(box).includes('item check'), false);
  writeFileSync(verifyRelease, 'release\n');
  await waitFor(() => events(box).includes('item check start'), 'the older verify check to acquire the released slot');
  assert.equal(existsSync(verifyFocusedMarker), false, 'the later focused run stays behind review');
  writeFileSync(checkRelease, 'release\n');
  await waitFor(() => events(box).includes('item check'), 'the verify check to release its slot');
  await waitFor(() => existsSync(verifyFocusedMarker), 'the focused run to start after review releases');
  const verifyRun = await verify.closed;
  assert.equal(verifyRun.code, 0, `${verify.stderrText}${verify.stdoutText}`);
  writeFileSync(verifyFocusedRelease, 'release\n');
  const [verifyHolderResult, verifyNextResult] = await Promise.all([verifyHolder.closed, verifyNext.closed]);
  assert.equal(verifyHolderResult.code, 0);
  assert.equal(verifyNextResult.code, 0, verifyNext.stderrText + verifyNext.stdoutText);
  assert.deepEqual(events(box), ['verify-holder start', 'verify-holder end', 'item check start', 'item check']);
});

test('[Q1,Q2] an older diagnostic stays ahead of a later ordinary gate', async () => {
  const box = fixture();
  const holderRelease = join(box.dir, 'release-diagnostic-holder');
  const diagnosticRelease = join(box.dir, 'release-diagnostic');
  const diagnosticStarted = join(box.dir, 'older-diagnostic.started');
  const diagnosticWaiting = join(box.dir, 'older-diagnostic.waiting');
  const holderRoot = gateRepo(box, 'diagnostic-holder', 0.1, holderRelease);
  const ordinaryRoot = gateRepo(box, 'later-ordinary-gate', 0.1);
  setOneGateSlot(box, holderRoot);
  const holder = launch(box, holderRoot);
  let diagnostic;
  let ordinary;
  try {
    await waitFor(() => events(box).includes('diagnostic-holder start'), 'the holder to acquire the only gate slot');
    diagnostic = launchDiagnostic(box, holderRoot, 'older-diagnostic', diagnosticStarted, diagnosticRelease, diagnosticWaiting);
    await waitFor(() => existsSync(diagnosticWaiting) || diagnostic.exitCode !== null, 'the older diagnostic to enter the queue');
    assert.equal(readFileSync(diagnosticWaiting, 'utf8'), '1', 'diagnostic is first in the waiting line');
    ordinary = launch(box, ordinaryRoot);
    await waitFor(() => ordinary.stdoutText.includes('place 2') || ordinary.exitCode !== null, 'the later ordinary gate to join behind the diagnostic');
    assert.ok(ordinary.stdoutText.includes('place 2'), 'the ordinary gate is physically second in the queue');
    writeFileSync(holderRelease, 'release\n');
    await waitFor(() => existsSync(diagnosticStarted), 'the older diagnostic to acquire the released slot');
    assert.equal(events(box).includes('later-ordinary-gate start'), false, 'the later ordinary gate stays queued while diagnostics hold the slot');
    writeFileSync(diagnosticRelease, 'release\n');
    await waitFor(() => events(box).includes('later-ordinary-gate start'), 'the ordinary gate to start after diagnostics release');
    const [holderResult, diagnosticResult, ordinaryResult] = await Promise.all([holder.closed, diagnostic.closed, ordinary.closed]);
    assert.equal(holderResult.code, 0, holder.stderrText);
    assert.equal(diagnosticResult.code, 0, diagnostic.stderrText + diagnostic.stdoutText);
    assert.equal(ordinaryResult.code, 0, ordinary.stderrText);
    assert.deepEqual(events(box), ['diagnostic-holder start', 'diagnostic-holder end', 'later-ordinary-gate start', 'later-ordinary-gate end']);
  } finally {
    writeFileSync(holderRelease, 'release\n');
    writeFileSync(diagnosticRelease, 'release\n');
    await Promise.all([holder, diagnostic, ordinary].filter(Boolean).map(child => child.closed));
  }
});

test('a raw full-suite run takes a machine gate slot [Q4]', async () => {
  const modes = [
    [],
    ['--test-name-pattern', PROBE_PATTERN, '--test-reporter', 'tap', '--test-concurrency', '1', '--test-shard', '1/1', '--experimental-test-isolation', 'process'],
    ['--disable-warning', 'ExperimentalWarning', '--title', 'pullboard-slot-probe', '--max-http-header-size', '16384'],
  ];
  for (const args of modes) {
    const box = fixture();
    const release = join(box.dir, 'release-full-suite-holder');
    const releaseProbe = join(box.dir, 'release-running-probe');
    const holderRoot = gateRepo(box, 'full-suite-holder', 0.1, release);
    const nextRoot = gateRepo(box, 'after-full-suite');
    const suiteRoot = probeSuite(box, 'raw-full-suite');
    const marker = join(box.dir, 'raw-full-suite.started');
    setOneGateSlot(box, holderRoot);
    const holder = launch(box, holderRoot);
    let fullRun;
    let followingGate;
    try {
      await waitFor(() => events(box).includes('full-suite-holder start'), 'the fixture gate to hold its only machine slot');
      fullRun = launchTestRunner(box, suiteRoot, args, marker, releaseProbe);
      const outcome = await waitFor(() => { // budget: hang ceiling for the raw runner to announce its actual queue state; no throughput claim.
        if (fullRun.stderrText.includes('waiting for a gate slot:')) return 'waiting';
        if (existsSync(marker)) return 'ran';
        return false;
      }, 'the raw full runner to announce its queued slot', 15_000);
      assert.equal(outcome, 'waiting', 'both bare and option-only discovery must queue without a test file');
      assert.match(fullRun.stderrText, /waiting for a gate slot: 1 of 1 in use/u);
      assert.equal(existsSync(marker), false, 'the probe has not run while the other process owns the slot');
      writeFileSync(release, 'release\n');
      assert.equal((await holder.closed).code, 0, holder.stderrText);
      await waitFor(() => existsSync(marker), 'the admitted full-suite probe to start');
      assert.equal(readFileSync(marker, 'utf8'), '1', 'the runner marks its child only after acquiring its machine slot');
      followingGate = launch(box, nextRoot);
      const holding = await waitFor(() => {
        if (followingGate.stdoutText.includes('gate waiting:')) return 'waiting';
        if (events(box).includes('after-full-suite start')) return 'ran';
        return false;
      }, 'the following gate to wait for the full test process');
      assert.equal(holding, 'waiting', 'the full runner holds its slot until its test process exits');
      assert.equal(events(box).includes('after-full-suite start'), false);
      writeFileSync(releaseProbe, 'release\n');
      const [fullResult, followingResult] = await Promise.all([fullRun.closed, followingGate.closed]);
      assert.equal(fullResult.code, 0, `${fullRun.stderrText}${fullRun.stdoutText}`);
      assert.equal(followingResult.code, 0, `${followingGate.stderrText}${followingGate.stdoutText}`);
      assert.equal((fullRun.stderrText.match(/waiting for a gate slot:/g) ?? []).length, 1, 'one wait line per full run');
    } finally {
      writeFileSync(release, 'release\n');
      writeFileSync(releaseProbe, 'release\n');
      await Promise.all([holder, fullRun, followingGate].filter(Boolean).map(child => child.closed));
    }
  }
});

test("the slot probe's marker is never seen half-written [Q4]", async () => {
  const box = fixture();
  const root = probeSuite(box, 'atomic-marker');
  const marker = join(box.dir, 'atomic-marker.started');
  const ready = join(box.dir, 'atomic-marker.write-ready');
  const release = join(box.dir, 'atomic-marker.write-release');
  const preload = join(box.dir, 'pause-probe-write.cjs');
  writeFileSync(preload, `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const target = process.env.${PROBE_WRITE_TARGET_ENV};
const ready = process.env.${PROBE_WRITE_READY_ENV};
const release = process.env.${PROBE_WRITE_RELEASE_ENV};
const originalWriteFileSync = fs.writeFileSync;
let paused = false;
/** Pause the probe after creating its marker path but before writing its value. */
fs.writeFileSync = function pauseProbeWrite(file, data, options) {
  const path = String(file);
  if (!paused && (path === target || path === target + '.tmp')) {
    paused = true;
    const fd = fs.openSync(path, 'w');
    originalWriteFileSync.call(fs, ready, 'ready');
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    try {
      if (!fs.existsSync(release)) throw new Error('parent did not release delayed probe write');
      return fs.writeSync(fd, data, 0, typeof options === 'string' ? options : options?.encoding ?? 'utf8');
    } finally { fs.closeSync(fd); }
  }
  return originalWriteFileSync.apply(this, arguments);
};
syncBuiltinESMExports();
`);
  const env = {
    [PROBE_WRITE_TARGET_ENV]: marker,
    [PROBE_WRITE_READY_ENV]: ready,
    [PROBE_WRITE_RELEASE_ENV]: release,
    NODE_OPTIONS: `${box.env.NODE_OPTIONS ? `${box.env.NODE_OPTIONS} ` : ''}--require=${JSON.stringify(preload)}`,
  };
  const runner = launchTestRunner(box, root, [], marker, null, env);
  let assertionError;
  try {
    await waitFor(() => existsSync(ready), 'the probe write to pause after creating its destination', 30_000); // budget: hang ceiling for the private paused-write marker handshake; no throughput claim.
    if (existsSync(marker)) assert.equal(readFileSync(marker, 'utf8'), '1', 'a visible marker already has its complete slot value');
  } catch (error) {
    assertionError = error;
  } finally {
    writeFileSync(release, 'release\n');
    const result = await runner.closed;
    assert.equal(result.code, 0, `${runner.stderrText}${runner.stdoutText}`);
  }
  if (assertionError) throw assertionError;
  await waitFor(() => existsSync(marker), 'the atomically published probe marker');
  assert.equal(readFileSync(marker, 'utf8'), '1', 'the final marker contains the complete slot value');
});

test('a short slot is offered only to a literal runner call over regular test files [C7]', async () => {
  const { explicitCheckFiles } = await import(BROWSER_ADMISSION_MODULE);
  const root = process.cwd();
  const named = `${quote(process.execPath)} bin/run-tests.js test/gate-resource.test.js`;
  assert.deepEqual(await explicitCheckFiles(root, named), ['test/gate-resource.test.js']);
  assert.deepEqual(await explicitCheckFiles(root, `out=$(${named} 2>&1); printf '%s\\n' "$out"; printf '%s\\n' "$out" | grep -Eq '^[[:space:]]*ok [0-9]+ - .*probe' && printf '%s\\n' "$out" | grep -Eq '^# fail 0$'`), ['test/gate-resource.test.js'], 'the frozen-check capture form names its files');
  assert.equal(await explicitCheckFiles(root, `${quote(process.execPath)} bin/run-tests.js`), null, 'a whole suite is not short');
  assert.equal(await explicitCheckFiles(root, `${quote(process.execPath)} bin/run-tests.js test/`), null, 'a directory is not short');
  assert.equal(await explicitCheckFiles(root, 'npm test test/gate-resource.test.js'), null, 'an opaque runner is not short');
  assert.equal(await explicitCheckFiles(root, 'node bin/run-tests.js $(printf test/gate-resource.test.js)'), null, 'shell expansion is not short');
  assert.equal(await explicitCheckFiles(root, 'node bin/run-tests.js --unknown test/gate-resource.test.js'), null, 'an unknown option is not short');
  assert.equal(await explicitCheckFiles(root, 'node bin/run-tests.js test/short-missing.test.js'), null, 'a missing file is not short');
  assert.equal(await explicitCheckFiles(root, named, { env: { ...process.env, NODE_OPTIONS: '--trace-warnings' } }), null, 'NODE_OPTIONS is not short');
  const head = runFixtureChild('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  assert.deepEqual(await explicitCheckFiles(root, named, { commit: head.stdout.trim() }), ['test/gate-resource.test.js'], 'a review reads the files from the submitted tree');
});

test('short slots behave the same with gate.browserByLaunch on [C7]', async () => {
  // With gate.browserByLaunch on, the runner adds its launch guard to NODE_OPTIONS for its children (#808). The
  // short-slot offer for the same named file must match under either setting: each run gets the environment the
  // runner gives its children for that setting, and both name the file. A foreign NODE_OPTIONS still refuses.
  const { explicitCheckFiles } = await import(BROWSER_ADMISSION_MODULE);
  const root = process.cwd();
  const named = `${quote(process.execPath)} bin/run-tests.js test/gate-resource.test.js`;
  const guard = pathToFileURL(resolve(root, 'src/browser-slot-guard.js')).href;
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_OPTIONS'));
  assert.deepEqual(await explicitCheckFiles(root, named, { env: base }), ['test/gate-resource.test.js'], 'with gate.browserByLaunch off');
  assert.deepEqual(await explicitCheckFiles(root, named, { env: { ...base, NODE_OPTIONS: `--import=${guard}` } }), ['test/gate-resource.test.js'], 'with gate.browserByLaunch on');
  assert.equal(await explicitCheckFiles(root, named, { env: { ...base, NODE_OPTIONS: '--import=file:///elsewhere/unclassified.js' } }), null, 'a foreign NODE_OPTIONS is not short');
});

test('a short check never waits behind whole suites [C7]', async () => {
  const box = fixture();
  const settingsRoot = gateRepo(box, 'settings-view');
  assert.equal(JSON.parse(pullboard(box, settingsRoot, ['settings', '--json'])).settings.gate.shortSlots, 0, 'gate.shortSlots defaults to 0');
  assert.match(pullboard(box, settingsRoot, ['settings']), /^gate\.shortSlots: 0 \(off/mu, 'pullboard settings shows the default');
  const refused = spawnSync(process.execPath, [BIN, 'settings', 'gate.shortSlots', 'two'], { cwd: settingsRoot, env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /BAD_SHORT_SLOTS/u);
  // Whole suites take a browser slot too; two of them fill a two-slot gate only with two browser slots.
  pullboard(box, settingsRoot, ['settings', 'gateSlots', '2']);
  pullboard(box, settingsRoot, ['settings', 'browserSlots', '2']);
  pullboard(box, settingsRoot, ['settings', 'gate.shortSlots', '1']);
  assert.equal(JSON.parse(pullboard(box, settingsRoot, ['settings', '--json'])).settings.gate.shortSlots, 1);
  assert.match(pullboard(box, settingsRoot, ['settings']), /^gate\.shortSlots: 1$/mu, 'pullboard settings shows the value');

  const holders = await wholeSuiteHolders(box, ['whole-one', 'whole-two']);
  const waiting = [];
  try {
    // Each waiter below is offered the free short slot on its first poll, so starting there would show at once.
    const ordinary = { marker: join(box.dir, 'ordinary.started'), release: join(box.dir, 'ordinary.release'), waiting: join(box.dir, 'ordinary.waiting') };
    ordinary.child = launchOrdinaryLease(box, settingsRoot, ordinary);
    waiting.push(ordinary);
    assert.equal(await waitFor(() => (existsSync(ordinary.marker) ? 'ran' : existsSync(ordinary.waiting) ? 'waiting' : false), 'an unnamed run to start or queue'),
      'waiting', 'a run that does not name its test files never takes the short slot, even with no browser');
    const wholeWaiter = { marker: join(box.dir, 'whole-waiter.started'), release: join(box.dir, 'whole-waiter.release') };
    wholeWaiter.child = launchTestRunner(box, probeSuite(box, 'whole-waiter'), [], wholeWaiter.marker, wholeWaiter.release);
    waiting.push(wholeWaiter);
    await waitFor(() => wholeWaiter.child.stderrText.includes('waiting for a gate slot:'), 'a third whole suite to queue');
    const directory = { marker: join(box.dir, 'directory.started'), release: join(box.dir, 'directory.release') };
    directory.child = launchTestRunner(box, shortProbeSuite(box, 'directory-run'), ['test/'], directory.marker, directory.release);
    waiting.push(directory);
    await waitFor(() => directory.child.stderrText.includes('waiting for a gate slot:'), 'a directory run to queue');
    const queued = JSON.parse(pullboard(box, settingsRoot, ['resources', '--json'])).resources.find(resource => resource.name === 'gate').line;
    assert.deepEqual(queued.map(waiter => waiter.kind), ['fixture-ordinary', 'gate', 'focused']);
    assert.equal(queued[1].requestedSlot, undefined, 'a whole suite is never offered a short slot');
    assert.equal(queued[2].requestedSlot, undefined, 'a directory run is never offered a short slot');
    const shortRoot = shortProbeSuite(box, 'short-run');
    const short = { marker: join(box.dir, 'short.started'), release: join(box.dir, 'short.release') };
    short.child = launchTestRunner(box, shortRoot, ['--test-name-pattern', PROBE_PATTERN, 'test/short-probe.test.js'], short.marker, short.release);
    waiting.push(short);
    const outcome = await waitFor(() => (existsSync(short.marker) ? 'ran' : short.child.stderrText.includes('waiting for a gate slot:') ? 'waiting' : false), 'the named-file run to start or queue');
    assert.equal(outcome, 'ran', 'with gate.shortSlots 1 a named-file run starts while both gate slots hold whole suites');
    assert.deepEqual([ordinary, wholeWaiter, directory].map(run => existsSync(run.marker)), [false, false, false], 'the runs queued ahead of it still wait');

    const status = JSON.parse(pullboard(box, settingsRoot, ['resources', '--json']));
    assert.equal(status.shortSlots, 1, 'pool status reports gate.shortSlots');
    const gate = status.resources.find(resource => resource.name === 'gate');
    assert.equal(gate.capacity, 2, 'short slots do not raise gateSlots');
    assert.deepEqual(gate.holders.map(holder => [holder.kind, holder.slot]).sort(), [['focused', 'short'], ['gate', 'gate'], ['gate', 'gate']],
      'pool status names the slot each run holds');
    const text = pullboard(box, settingsRoot, ['resources']);
    const gateText = text.slice(text.indexOf('\ngate (machine'));
    assert.equal((gateText.match(/held by .*\(short slot, focused\)/gu) ?? []).length, 1, 'the text status names the short slot');
    assert.equal((gateText.match(/held by .*\(gate slot, gate, browser\)/gu) ?? []).length, 2, 'the text status names each gate slot');
    const reuse = wholeSuiteInheritance(box, settingsRoot, JSON.parse(readFileSync(short.marker, 'utf8')));
    assert.equal(reuse.stdout, 'SHORT_SLOT_FULL_SUITE', 'a whole suite cannot reuse a short lease from inside the short check');
  } finally {
    await releaseAll([...holders, ...waiting]);
  }
  for (const run of [...holders, ...waiting]) {
    const { code } = await run.child.closed;
    // Node refuses a directory operand once the run is admitted; only its queueing is under test here.
    if (run.child.stdoutText.includes('ERR_UNSUPPORTED_DIR_IMPORT')) assert.equal(code, 1);
    else assert.equal(code, 0, `${run.child.stderrText}${run.child.stdoutText}`);
  }

  const off = fixture();
  const offRoot = gateRepo(off, 'settings-off');
  pullboard(off, offRoot, ['settings', 'gateSlots', '2']);
  pullboard(off, offRoot, ['settings', 'browserSlots', '2']);
  pullboard(off, offRoot, ['settings', 'gate.shortSlots', '0']);
  const offHolders = await wholeSuiteHolders(off, ['off-one', 'off-two']);
  const named = { marker: join(off.dir, 'named.started'), release: join(off.dir, 'named.release') };
  try {
    named.child = launchTestRunner(off, shortProbeSuite(off, 'named-off'), ['--test-name-pattern', PROBE_PATTERN, 'test/short-probe.test.js'], named.marker, named.release);
    const outcome = await waitFor(() => (existsSync(named.marker) ? 'ran' : named.child.stderrText.includes('waiting for a gate slot:') ? 'waiting' : false), 'the named-file run to start or queue');
    assert.equal(outcome, 'waiting', 'with gate.shortSlots 0 a named-file run waits for a gate slot, as before');
    const gate = JSON.parse(pullboard(off, offRoot, ['resources', '--json'])).resources.find(resource => resource.name === 'gate');
    assert.equal(gate.line.length, 1);
    assert.equal(gate.line[0].requestedSlot, 'short-eligible', 'the waiting run is marked as one that names its files');
    writeFileSync(offHolders[0].release, 'release\n');
    await waitFor(() => existsSync(named.marker), 'the named-file run to start once a gate slot frees');
  } finally {
    await releaseAll(named.child ? [...offHolders, named] : offHolders);
  }
  for (const run of named.child ? [...offHolders, named] : offHolders) assert.equal((await run.child.closed).code, 0, `${run.child.stderrText}${run.child.stdoutText}`);
});

test('a focused run queues behind a held gate slot [Q4,C7]', async () => {
  const box = fixture();
  const release = join(box.dir, 'release-focused-holder');
  const holderRoot = gateRepo(box, 'focused-holder', 0.1, release);
  const suiteRoot = probeSuite(box, 'focused-suite');
  const marker = join(box.dir, 'focused-suite.started');
  setOneGateSlot(box, holderRoot);
  const holder = launch(box, holderRoot);
  let focusedRun;
  try {
    await waitFor(() => events(box).includes('focused-holder start'), 'the fixture gate to hold its only machine slot');
    focusedRun = launchTestRunner(box, suiteRoot, [
      '--test-name-pattern', PROBE_PATTERN,
      '--disable-warning', 'ExperimentalWarning', '--title', 'focused-slot-probe',
      'test/probe.test.js',
    ], marker);
    const outcome = await waitFor(() => { // budget: hang ceiling for the focused runner to announce its actual start state; no throughput claim.
      if (focusedRun.stderrText.includes('waiting for a gate slot:')) return 'waiting';
      if (existsSync(marker)) return 'ran';
      return false;
    }, 'the focused test to queue behind the held machine gate slot', 15_000);
    assert.equal(outcome, 'waiting', 'a named test file is queued even when test options have separate values');
    assert.equal(existsSync(marker), false, 'the focused test does not execute while the original holder owns the only slot');
    assert.deepEqual(events(box), ['focused-holder start'], 'the original gate still owns its slot while the focused run waits');
    writeFileSync(release, 'release\n');
    const focusedResult = await focusedRun.closed;
    assert.equal(focusedResult.code, 0, `${focusedRun.stderrText}${focusedRun.stdoutText}`);
    assert.equal(readFileSync(marker, 'utf8'), '1', 'the focused run propagates its public held-slot marker to the test process');
    assert.deepEqual(events(box), ['focused-holder start', 'focused-holder end'], 'the original holder releases before the focused run proceeds');
  } finally {
    writeFileSync(release, 'release\n');
    await Promise.all([holder, focusedRun].filter(Boolean).map(child => child.closed));
  }
});

test('a full run nested under a held gate does not take a second slot [Q4]', async () => {
  const box = fixture();
  const gateRoot = gateRepo(box, 'nested-full-suite');
  probeSuite(box, 'nested-full-suite');
  const marker = join(box.dir, 'nested-full-suite.started');
  const output = join(box.dir, 'nested-full-suite-runner.log');
  const command = `${quote(process.execPath)} ${quote(RUNNER)} --test-name-pattern ${quote(PROBE_PATTERN)} > ${quote(output)} 2>&1`;
  writeFileSync(join(gateRoot, 'pullboard.json'), JSON.stringify({ gate: command }));
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: gateRoot, env: box.env }).status, 0);
  const policyCommit = spawnSync('git', ['commit', '-q', '-m', 'chore: add nested runner probe'], { cwd: gateRoot, env: box.env, encoding: 'utf8' });
  assert.equal(policyCommit.status, 0, policyCommit.failure ?? policyCommit.stderr);
  setOneGateSlot(box, gateRoot);
  const nestedGate = launch({ ...box, env: { ...box.env, [PROBE_PATH_ENV]: marker } }, gateRoot);
  try {
    const outcome = await waitFor(() => { // budget: hang ceiling for the nested runner marker handshake; no throughput claim.
      if (existsSync(marker)) return 'completed';
      if (existsSync(output) && readFileSync(output, 'utf8').includes('waiting for a gate slot:')) return 'queued';
      return false;
    }, 'the nested runner to complete or expose a second-slot wait', 15_000);
    const runnerOutput = existsSync(output) ? readFileSync(output, 'utf8') : '';
    assert.equal(outcome, 'completed', `the child must inherit the held parent slot, not wait on its own slot; output=${runnerOutput}`);
    assert.equal(readFileSync(marker, 'utf8'), '1', 'the nested test child inherited the actual parent-held-slot marker');
    const result = await nestedGate.closed;
    assert.equal(result.code, 0, `${nestedGate.stderrText}${nestedGate.stdoutText}`);
  } finally {
    if (nestedGate.exitCode === null && nestedGate.signalCode === null) {
      try { process.kill(-nestedGate.pid, 'SIGKILL'); } catch { /* The gate already exited. */ }
    }
    await nestedGate.closed;
  }
});
