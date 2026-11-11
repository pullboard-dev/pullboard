/** @pullboard-test-input source-tree */
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import { repoPath } from '../../../../packages/kernel/light.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import '../../tests/fixtures/main/audit/cases.js';
import '../../../../packages/gate/tests/io/main/audit/attribution.test.js';
/** The landing gate splits its test files into shards across local slots and runners [C7,V4]. */
import { awaitNestedRun } from '../../../../packages/gate/index.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  configProblems,
  defaults,
} from '../../../../packages/config/index.js';
import { landingShardCount } from '../../../../packages/gate/index.js';
import {
  landingBalance,
  landingFloor,
  landingSource,
  planLandingShards,
  shardFileTimes,
} from '../../../../packages/landing/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { stopGroup } from '../../tests/fixtures/runner/group.js';
import { installRegistrationProbeStandIn } from '../../tests/fixtures/runner/ssh.js';

const SOURCE = resolve(import.meta.dirname, '../../../..');
const BIN = join(SOURCE, 'apps/cli/pullboard.js');
const HOST = 'fixture-host';
const NAMES = ['a', 'b', 'c', 'd', 'e', 'f'];

/** The full published copy contains unrelated docs tests; this fixture gates exactly its original probe universe. */
function fixtureGate(names = NAMES) { return 'node packages/gate/src/io/run/tests.js ' + names.map(name => `test/${name}.test.js`).join(' '); }

test('GUI-marked landing files use only a runner with a GUI session [C7,V4]', (t) => {
  const box = fixture({ runner: false });
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const hosts = ['fixture-no-gui', 'fixture-gui'];
  for (const host of hosts) {
    const added = runFixtureChild(process.execPath, [BIN, 'runner', 'add', host, '--slots', '1', '--browser', '1', '--json'],
      { cwd: box.repo, env: box.env, encoding: 'utf8' });
    assert.equal(added.status, 0, added.context);
  }
  // These are seeded capability reports, not a claim about this test machine's desktop session.
  const selected = join(box.repo, 'test/a.test.js');
  writeFileSync(selected, '/** @pullboard-test-gui */\n' + readFileSync(selected, 'utf8'));
  git(box.repo, box.env, 'add', '.');
  git(box.repo, box.env, 'commit', '-q', '-m', 'test: GUI-marked private fixture');
  const script = `import {recordRunnerGui} from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/resources/index.js')).href)};
for(const host of ${JSON.stringify(hosts)}) recordRunnerGui(host,host==='fixture-gui');
import { withGateSlot } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)};
${executionServicesSource(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)}
import { runLandingShards } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/landing/index.js')).href)};
import { parseProcessCensus } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/kernel/src/logic/census.js')).href)};
const root = ${JSON.stringify(box.repo)};
const calls = [];
const remoteRun = async (_root, _command, options) => {
  calls.push({ host: options.runner.host, gui: options.runner.gui ?? null });
  return { isGreen: true, output: '' };
};
// Actual private SQLite leases occupy both local slots, forcing the planner to choose a runner.
const result = await withGateSlot(root, () => withGateSlot(root, () => runLandingShards({ parseProcessCensus, root,
  runner: ${JSON.stringify(join(box.repo, 'packages/gate/src/io/run/tests.js'))}, files: ['./test/a.test.js'], count: 1,
  needsBrowser: async () => true, needsGui: async () => true, remoteRun, write: () => {},
}), { executionServices, remote: false, kind: 'check' }), { executionServices, remote: false, kind: 'check' });
process.stdout.write(JSON.stringify({ green: result.isGreen, calls }));`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.green, true);
  assert.deepEqual(measured.calls.map(call => call.host), ['fixture-gui'], 'a GUI-marked file never runs on the first, no-GUI runner');
  assert.equal(measured.calls[0].gui, true, 'the selected runner carries its explicit GUI capability');
});

test('a GUI-marked shard waits for a local slot when runner GUI capability is unknown [C7,V4]', t => {
  const box = fixture({ runner: true });
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const script = `import { recordRunnerGui } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/resources/index.js')).href)};
// This scenario seeds its capability after registration, whose real desktop probe may report true.
recordRunnerGui(${JSON.stringify(HOST)}, null);
import { withGateSlot } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)};
${executionServicesSource(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)}
import { runLandingShards } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/landing/index.js')).href)};
import { parseProcessCensus } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/kernel/src/logic/census.js')).href)};
const root = ${JSON.stringify(box.repo)};
let release;
let entered;
const ready = new Promise(resolve => { entered = resolve; });
const freed = new Promise(resolve => { release = resolve; });
const result = await withGateSlot(root, async () => {
  const held = withGateSlot(root, async () => { entered(); await freed; }, { executionServices, remote: false });
  await ready;
  const timer = setTimeout(release, 250);
  try {
    return await runLandingShards({ parseProcessCensus, root, runner: ${JSON.stringify(join(box.repo, 'packages/gate/src/io/run/tests.js'))},
      files: ['./test/a.test.js'], count: 1, needsBrowser: async () => false, needsGui: async () => true,
      remoteRun: async () => { throw new Error('an unknown GUI runner must not execute this shard'); }, write: () => {} });
  } finally { clearTimeout(timer); release(); await held; }
}, { executionServices, remote: false });
process.stdout.write(JSON.stringify(result));`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.isGreen, true);
  assert.equal(measured.shards[0].attempts[0].host, 'local');
});

test('a no-GUI remote parent gives its first GUI shard to a compatible local slot [C7,V4]', t => {
  const box = fixture({ runner: true });
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const settingsPath = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.runners = settings.runners.map(runner => ({ ...runner, gui: false }));
  writeFileSync(settingsPath, JSON.stringify(settings));
  const script = `import { recordRunnerGui } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/resources/index.js')).href)};
// This scenario seeds its capability after registration, whose real desktop probe may report true.
recordRunnerGui(${JSON.stringify(HOST)}, false);
import assert from 'node:assert/strict';
import { withGateSlot } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)};
${executionServicesSource(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)}
import { runLandingShards } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/landing/index.js')).href)};
import { parseProcessCensus } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/kernel/src/logic/census.js')).href)};
const root = ${JSON.stringify(box.repo)};
let release;
let entered;
const ready = new Promise(resolve => { entered = resolve; });
const freed = new Promise(resolve => { release = resolve; });
const result = await withGateSlot(root, async () => {
  const held = withGateSlot(root, async () => { entered(); await freed; }, { executionServices, remote: false });
  await ready;
  try {
    return await withGateSlot(root, async inherited => {
      assert.equal(inherited.runner.host, ${JSON.stringify(HOST)});
      assert.equal(inherited.runner.gui, false);
      const timer = setTimeout(release, 250);
      try { return await runLandingShards({ parseProcessCensus, root, inherited, runner: ${JSON.stringify(join(box.repo, 'packages/gate/src/io/run/tests.js'))},
        files: ['./test/a.test.js'], count: 1, needsBrowser: async () => false, needsGui: async () => true,
        remoteRun: async () => { throw new Error('a no-GUI inherited runner must not execute this shard'); }, write: () => {} }); }
      finally { clearTimeout(timer); }
    }, { executionServices });
  } finally { release(); await held; }
}, { executionServices, remote: false });
process.stdout.write(JSON.stringify(result));`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.isGreen, true);
  assert.equal(measured.shards[0].attempts[0].host, 'local');
});

test('six shards land on six different runners [C7,V4]', (t) => {
  const box = fixture({ runner: false });
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const hosts = NAMES.map(name => `fixture-${name}`);
  for (const host of hosts) {
    const added = runFixtureChild(process.execPath, [BIN, 'runner', 'add', host, '--slots', '4', '--browser', '4', '--json'],
      { cwd: box.repo, env: box.env, encoding: 'utf8' });
    assert.equal(added.status, 0, added.context);
  }
  // With two or more runners the first is kept for timed checks by default; this test needs all six open to shards.
  const machineSettings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), keptSettings = JSON.parse(readFileSync(machineSettings, 'utf8'));
  writeFileSync(machineSettings, JSON.stringify({ ...keptSettings, gate: { ...keptSettings.gate, timingRunner: false } }));
  const script = `import { withGateSlot } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)};
${executionServicesSource(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)}
import { runLandingShards } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/landing/index.js')).href)};
import { parseProcessCensus } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/kernel/src/logic/census.js')).href)};
const root = ${JSON.stringify(box.repo)};
const calls = [];
let release;
const allStarted = new Promise(resolve => { release = resolve; });
const remoteRun = async (_root, _command, options) => {
  calls.push(options.runner.host);
  if (calls.length === 6) release();
  await allStarted;
  return { isGreen: true, output: '' };
};
// Hold the two real local slots, so all six shards must acquire actual registered runner leases.
const result = await withGateSlot(root, () => withGateSlot(root, () => runLandingShards({ parseProcessCensus, root,
  runner: ${JSON.stringify(join(box.repo, 'packages/gate/src/io/run/tests.js'))},
  files: ${JSON.stringify(NAMES.map(name => `./test/${name}.test.js`))}, count: 6, remoteRun, write: () => {},
}), { executionServices, remote: false, kind: 'check' }), { executionServices, remote: false, kind: 'check' });
process.stdout.write(JSON.stringify({ green: result.isGreen, calls }));`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.green, true);
  assert.equal(measured.calls.length, 6, 'all six shards used the registered runner admission path');
  assert.deepEqual([...new Set(measured.calls)].sort(), hosts, 'every runner gets a shard before another gets two');
});

/** Run Git in a fixture repository and fail with its context. */
function git(cwd, env, ...args) {
  const result = runFixtureChild('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  return result.stdout.trim();
}

/**
 * Make a local ssh stand-in that runs the worker command in a second private machine home.
 * With `dropOnce`, its first session kills the worker as soon as a test file starts on the runner,
 * the way a runner that loses power mid-shard looks to the controller.
 */
function installSshStandIn({ bin, worker, home, machineHome, markers, dropOnce }) {
  const source = `#!/usr/bin/env node
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const argv = process.argv.slice(2);
const divider = argv.indexOf('--');
const host = argv[divider + 1];
const remoteCommand = argv[divider + 2];
if (host !== ${JSON.stringify(HOST)}) process.exit(255);
const dropFlag = ${JSON.stringify(dropOnce ?? '')};
const drop = dropFlag && !existsSync(dropFlag);
if (drop) writeFileSync(dropFlag, 'dropped\\n');
const env = { PATH: process.env.PATH, HOME: ${JSON.stringify(home)}, TMPDIR: process.env.TMPDIR,
  PULLBOARD_HOME: ${JSON.stringify(home)}, PULLBOARD_MACHINE_HOME: ${JSON.stringify(machineHome)}, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
const child = spawn('/bin/sh', ['-c', remoteCommand], { cwd: ${JSON.stringify(worker)}, env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.pipe(child.stdin);
if (drop) {
  const timer = setInterval(() => {
    if (!readdirSync(${JSON.stringify(markers)}).some(name => name.endsWith('.runner.started'))) return;
    clearInterval(timer);
    process.kill(child.pid, 'SIGHUP');
    process.exit(255);
  }, 20);
}
child.once('close', (code, signal) => { process.exitCode = signal ? 128 : (code ?? 255); });
`;
  const ssh = join(bin, 'ssh');
  writeFileSync(ssh, source, { mode: 0o700 });
  chmodSync(ssh, 0o700);
}

/** A fixture test file: it marks where it ran and behaves as the current mode file says. */
function fixtureTestFile(name, { markers, mode }) {
  return `import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const name = ${JSON.stringify(name)};
const host = process.cwd().includes('worker-home') ? 'runner' : 'local';
const mode = existsSync(${JSON.stringify(mode)}) ? readFileSync(${JSON.stringify(mode)}, 'utf8').trim() : 'green';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('fixture file ' + name, async () => {
  writeFileSync(${JSON.stringify(markers)} + '/' + name + '.' + host + '.started', '');
  if (mode === 'collect-all' && (name === 'a' || name === 'b')) throw new Error('collect-all deliberate failure ' + name);
  if (mode === 'collect-all') {
    if (process.env.PULLBOARD_LANDING_COLLECT_ALL !== undefined || process.env.PULLBOARD_LANDING_COLLECTION_ID !== undefined) throw new Error('collect-all marker leaked into test child');
    writeFileSync(${JSON.stringify(markers)} + '/' + name + '.' + host + '.finished', '');
    return;
  }
  if (mode === 'fail' && name === 'a') throw new Error('fixture failure in file a');
  if (mode === 'late-fail' && name === 'a') { await sleep(6_000); throw new Error('late fixture failure in file a'); }
  // Long enough that only a stop can end the other files before the scenario's deadline.
  await sleep(mode === 'fail' || (mode === 'drop' && host === 'runner') ? 40_000 : 1_500);
  writeFileSync(${JSON.stringify(markers)} + '/' + name + '.' + host + '.finished', '');
});
`;
}

/** Build a committed fixture project holding this Pullboard's runner and six test files. */
function fixture({ runner = true, repoNames = ['repo'] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-landing-shards-')));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repos = repoNames.map(name => join(dir, name));
  const repo = repos[0];
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const markers = join(dir, 'markers');
  const mode = join(dir, 'mode');
  for (const folder of [home, machineHome, remoteHome, remoteMachineHome, worker, bin, markers, ...repos.map(path => join(path, 'test'))]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 2 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Landing Shards Fixture', GIT_AUTHOR_EMAIL: 'landing-shards@example.invalid',
    GIT_COMMITTER_NAME: 'Landing Shards Fixture', GIT_COMMITTER_EMAIL: 'landing-shards@example.invalid',
  };
  for (const key of Object.keys(env)) {
    if (/^PULLBOARD_(GATE_SLOT|BROWSER_SLOT|LANDING)/u.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  }
  for (const path of repos) {
    copyPackageFiles(SOURCE, path);
    for (const name of NAMES) writeFileSync(join(path, `test/${name}.test.js`), fixtureTestFile(name, { markers, mode }));
    writeFileSync(join(path, 'pullboard.json'), JSON.stringify({ gate: fixtureGate(), landingShards: 3 }));
    git(path, env, 'init', '-q', '-b', 'main');
    git(path, env, 'add', '.');
    git(path, env, 'commit', '-q', '-m', 'test: landing shards fixture');
  }
  installRegistrationProbeStandIn({ bin });
  if (runner) {
    const added = runFixtureChild(process.execPath, [BIN, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(added.status, 0, added.context);
  }
  return { dir, repo, repos, env, bin, worker, remoteHome, remoteMachineHome, markers, mode };
}

/** Clear a scenario's markers and pick its mode. */
function scenario(box, mode, { dropOnce } = {}) {
  rmSync(box.markers, { recursive: true, force: true });
  mkdirSync(box.markers);
  writeFileSync(box.mode, `${mode}\n`);
  installSshStandIn({ bin: box.bin, worker: box.worker, home: box.remoteHome, machineHome: box.remoteMachineHome,
    markers: box.markers, dropOnce: dropOnce ? join(box.dir, `dropped-${mode}`) : '' });
}

/**
 * Run the fixture's landing gate (the same runGate call `gate --landing` makes) in its own process
 * group. Past its deadline the whole group is stopped and the scenario fails naming itself.
 */
async function landingGate(box, label, deadlineMs, repo = box.repo) {
  return await awaitNestedRun(startLandingGate(box, label, deadlineMs, repo));
}

/** Start a landing immediately; callers may start several before lending their one place serially. */
function startLandingGate(box, label, deadlineMs, repo = box.repo) {
  const gateUrl = pathToFileURL(join(repo, 'packages', 'gate', 'index.js')).href;
  const configUrl = pathToFileURL(join(repo, 'packages/config/index.js')).href;
  const script = `const { runGate } = await import(${JSON.stringify(gateUrl)});
${executionServicesSource(gateUrl)}
const { loadConfig } = await import(${JSON.stringify(configUrl)});
const root = ${JSON.stringify(repo)};
const gate = await runGate(root, loadConfig(root), { executionServices, landing: true, trustStamp: false, agent: 'landing-shards-fixture', collectAll: ${box.collectAll === true} });
process.stdout.write(JSON.stringify({ isGreen: gate.isGreen, collectAllComplete: gate.collectAllComplete, output: gate.output, profile: gate.profile }));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  const closed = new Promise(resolveClose => child.once('close', (status, signal) => resolveClose({ status, signal })));
  // Deadline cancellation stays inside the helper, never outside a raced loan promise.
  const terminal = (async () => {
    let timer;
    const deadline = new Promise(resolveDeadline => { timer = setTimeout(() => resolveDeadline(null), deadlineMs); });
    const ended = await Promise.race([closed, deadline]);
    clearTimeout(timer);
    if (!ended) {
      for (const signal of ['SIGTERM', 'SIGKILL']) { try { process.kill(-child.pid, signal); } catch { /* already gone */ } }
      await closed;
      throw new Error(`landing gate scenario "${label}" passed its ${deadlineMs} ms deadline\n${stdout.slice(-4_000)}\n${stderr.slice(-4_000)}`);
    }
    assert.equal(ended.status, 0, `scenario "${label}": the gate process failed\n${stderr.slice(-4_000)}`);
    return { ...JSON.parse(stdout), stderr };
  })().finally(() => stopGroup(child, closed));
  terminal.child = child;
  // A sibling may finish before this promise gets its turn to borrow; retain its original rejection.
  void terminal.catch(() => {});
  return terminal;
}

/** The merged log's per-file lines as {file: {shard, host}}. */
function mergedFiles(output) {
  const files = {};
  for (const match of output.matchAll(/^# landing file (\d+\/\d+) (\S+) (\d+|-) (.+)$/gmu)) {
    assert.equal(files[match[4]], undefined, `${match[4]} is listed once`);
    files[match[4]] = { shard: match[1], host: match[2] };
  }
  return files;
}

/** Markers left by the fixture files, as a sorted list. */
function marks(box, suffix) {
  return readdirSync(box.markers).filter(name => name.endsWith(suffix)).sort();
}

test('a landing gate split into shards reports one result [C7,V4]', { timeout: 300_000 }, async (t) => { // budget: three bounded landing scenarios on one fixture.
  // The planner: no times balances by count; known times put the heavy files on their own shards.
  const six = NAMES.map(name => `./test/${name}.test.js`);
  assert.deepEqual(planLandingShards(six, 3).map(shard => shard.files.length), [2, 2, 2]);
  const weighted = planLandingShards(six, 3, { 'test/a.test.js': 900, 'test/b.test.js': 800, 'test/c.test.js': 100, 'test/d.test.js': 100, 'test/e.test.js': 100, 'test/f.test.js': 100 });
  assert.deepEqual(weighted.map(shard => shard.files), [['./test/a.test.js'], ['./test/b.test.js'], ['./test/c.test.js', './test/d.test.js', './test/e.test.js', './test/f.test.js']]);
  assert.equal(landingBalance(six), 'file count', 'with no history the plan names its file-count fallback');
  assert.equal(landingBalance(six, { 'test/a.test.js': 900 }), 'history and average');
  assert.equal(landingBalance(six, Object.fromEntries(NAMES.map(name => [`test/${name}.test.js`, 10]))), 'history');
  assert.deepEqual(landingFloor(six, { 'test/a.test.js': 900, 'test/b.test.js': 50 }), { path: 'test/a.test.js', ms: 900 });
  assert.equal(landingFloor(six), null);
  assert.deepEqual(shardFileTimes('# landing-file-ms 42 test/a.test.js\nnoise\n'), { 'test/a.test.js': 42 });
  assert.equal(configProblems({ ...defaults(), landingShards: 0 }).some(problem => problem.includes('"landingShards"')), true);
  assert.deepEqual(configProblems({ ...defaults(), landingShards: 3 }), []);

  const box = fixture();
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  assert.equal(landingShardCount(box.repo), 3);

  // Green: three shards, one of them on the runner, every file once, one green result.
  scenario(box, 'green');
  const green = await landingGate(box, 'green', 120_000);
  assert.equal(green.isGreen, true, green.output);
  const files = mergedFiles(green.output);
  assert.deepEqual(Object.keys(files).sort(), NAMES.map(name => `test/${name}.test.js`));
  assert.deepEqual([...new Set(Object.values(files).map(file => file.shard))].sort(), ['1/3', '2/3', '3/3']);
  assert.ok(Object.values(files).some(file => file.host === HOST), `one shard runs on the registered runner\n${green.output}`);
  assert.ok(Object.values(files).some(file => file.host === 'local'), 'the others run on local slots');
  assert.match(green.output, /^# landing result: green$/mu);
  assert.match(green.output, /^# landing shards: 3 balanced by file count \(/mu, 'the first landing has no history');
  assert.equal(green.profile.landingShards.balance, 'file count');
  assert.equal(green.profile.landingShards.files.length, 6, 'the profile names every file once');
  assert.ok(green.profile.landingShards.files.every(file => file.shard && file.host));
  assert.equal(green.profile.landingShards.shards.filter(shard => shard.status === 'green').length, 3);
  assert.equal(marks(box, '.finished').length, 6);
  // Every file's measured wall time is kept, so the next landing balances by real history.
  const history = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'landing-file-times.json'), 'utf8'));
  assert.deepEqual(Object.keys(history.files).sort(), NAMES.map(name => `test/${name}.test.js`));
  assert.ok(Object.values(history.files).every(ms => Number.isFinite(ms) && ms > 0), 'each file has a measured wall time');
  assert.ok(green.profile.landingShards.files.every(file => Number.isFinite(file.durationMs) && file.durationMs > 0));

  // One failing file: the gate goes red and the other shards are stopped, long before their files end.
  scenario(box, 'fail');
  const red = await landingGate(box, 'failing shard', 60_000);
  assert.notEqual(red.collectAllComplete,true,'cancelled failfast siblings never establish full collection');
  assert.equal(red.isGreen, false, red.output);
  assert.match(red.output, /^# landing shard \d\/3 attempt 1 on \S+: red in \d+ ms$/mu);
  assert.equal([...red.output.matchAll(/^# landing shard \d\/3 attempt \d+ on \S+: stopped in \d+ ms$/gmu)].length, 2, red.output);
  // A test failure is not infrastructure: nothing reruns and nothing falls back.
  assert.doesNotMatch(red.output, /rerunning shard|infrastructure/u);
  assert.equal(red.profile.landingShards.shards.length, 3, 'one attempt per shard');
  assert.match(red.output, /^# landing result: red, first failure in shard \d\/3$/mu);
  assert.match(red.output, /^# landing shards: 3 balanced by history \(/mu, 'the second landing balances by the first one\'s wall times');
  assert.match(red.output, /^# landing floor: \d+ ms test\/[a-f]\.test\.js$/mu, 'the slowest recorded file is named as the floor');
  assert.equal(green.profile.landingShards.floor, null, 'with no history there is no floor yet');
  assert.ok(red.profile.landingShards.floor.ms > 0);
  // Every other file sleeps far past this scenario's deadline, so none finishing means each was stopped.
  assert.deepEqual(marks(box, '.finished'), [], 'no stopped file ran to its end');

  // A shard that fails after the others went green still makes the whole landing red.
  scenario(box, 'late-fail');
  const late = await landingGate(box, 'late failing shard', 60_000);
  assert.equal(late.isGreen, false, late.output);
  assert.ok(late.profile.landingShards.shards.some(shard => shard.status === 'green'), `another shard was green first\n${late.output}`);
  assert.equal(late.profile.landingShards.shards.filter(shard => shard.status === 'red').length, 1);

  // A runner killed mid-shard: its shard reruns locally with a named line and the gate stays green.
  scenario(box, 'drop', { dropOnce: true });
  const dropped = await landingGate(box, 'killed runner', 150_000);
  assert.equal(dropped.isGreen, true, dropped.output);
  const rerun = /^landing shard (\d\/3): runner fixture-host failed mid-shard; rerunning shard \1 locally$/mu.exec(dropped.output);
  assert.ok(rerun, `the rerun is named\n${dropped.output}`);
  const label = rerun[1].replace('/', '\\/');
  // Both attempts stay in the log and the profile: the failed runner attempt first, then the local rerun.
  assert.match(dropped.output, new RegExp(`^# landing shard ${label} attempt 1 on ${HOST}: infrastructure \\(runner transport lost\\) in \\d+ ms$`, 'mu'));
  assert.match(dropped.output, new RegExp(`^# landing shard ${label} attempt 2 on local: green in \\d+ ms$`, 'mu'));
  const attempts = dropped.profile.landingShards.shards.filter(shard => shard.shard === rerun[1]);
  assert.deepEqual(attempts.map(shard => [shard.attempt, shard.host, shard.status]), [[1, HOST, 'infrastructure'], [2, 'local', 'green']]);
  assert.ok(marks(box, '.runner.started').length > 0, 'the shard had started on the runner');
  assert.deepEqual(marks(box, '.finished').filter(name => name.endsWith('.local.finished')).length, 6, 'every file finished locally');

  // Two sharded landings at once on a machine with only two slots and no runner: each parent holds
  // one slot and runs its own shards on it, so neither waits forever on the other's.
  const pair = fixture({ runner: false, repoNames: ['first', 'second'] });
  t.after(() => rmSync(pair.dir, { recursive: true, force: true }));
  scenario(pair, 'green');
  const started = pair.repos.map((repo, index) => startLandingGate(pair, `concurrent landing ${index + 1}`, 120_000, repo));
  const both = [];
  let firstFailure;
  for (const terminal of started) {
    try { both.push(await awaitNestedRun(terminal)); }
    catch (error) { firstFailure ??= error; }
  }
  if (firstFailure) throw firstFailure;
  for (const landing of both) {
    assert.equal(landing.isGreen, true, landing.output);
    assert.equal(Object.keys(mergedFiles(landing.output)).length, 6);
  }
});

/**
 * Run a sharded landing in a child process where the SSH round trip is replaced by one that answers
 * every runner call with `answer` (a refusal code, or DROPPED for a lost transport).
 */
async function landingWithRunnerAnswer(box, answer, count, deadlineMs) {
  const url = name => JSON.stringify(pathToFileURL(repoPath(SOURCE, name)).href);
  const files = NAMES.map(name => `./test/${name}.test.js`);
  const script = `const { runLandingShards } = await import(${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/landing/index.js')).href)});
const { parseProcessCensus } = await import(${url('packages/kernel/src/logic/census.js')});
const { landingShardProfile } = await import(${url('packages/gate/index.js')});
const { Refused } = await import(${url('packages/kernel/index.js')});
const { RunnerDropped } = await import(${url('packages/gate/light.js')});
const { appendFileSync } = await import('node:fs');
const answer = ${JSON.stringify(answer)};
const calls = [];
const remoteRun = async (_root, _command, options) => {
  calls.push(options.runner.host);
  if (answer === 'DROPPED') throw new RunnerDropped(options.runner.host);
  if (answer === 'DROPPED_AFTER_EDIT') {
    // The checkout moves on while the landing runs: a rerun must not test this source instead.
    appendFileSync(${JSON.stringify(join(box.repo, 'test/f.test.js'))}, '\\n// edited while the landing ran\\n');
    throw new RunnerDropped(options.runner.host);
  }
  throw new Refused(answer, 'runner ' + options.runner.host + ' answered ' + answer + '; inspect job fixture-job under its runner namespace before another run');
};
const chunks = [];
const result = await runLandingShards({ parseProcessCensus, root: ${JSON.stringify(box.repo)}, runner: ${JSON.stringify(join(box.repo, 'packages/gate/src/io/run/tests.js'))},
  files: ${JSON.stringify(files)}, count: ${count}, remoteRun, write: text => chunks.push(text) });
const output = chunks.join('');
process.stdout.write(JSON.stringify({ isGreen: result.isGreen, output, calls, profile: landingShardProfile(output) }));`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: box.repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  const closed = new Promise(resolveClose => child.once('close', status => resolveClose({ status })));
  const terminal = (async () => {
    let timer;
    const ended = await Promise.race([closed, new Promise(resolveDeadline => { timer = setTimeout(() => resolveDeadline(null), deadlineMs); })]);
    clearTimeout(timer);
    if (!ended) {
      for (const signal of ['SIGTERM', 'SIGKILL']) { try { process.kill(-child.pid, signal); } catch { /* already gone */ } }
      await closed;
      throw new Error(`runner answer "${answer}" passed its ${deadlineMs} ms deadline\n${stderr.slice(-4_000)}`);
    }
    assert.equal(ended.status, 0, `runner answer "${answer}": the landing process failed\n${stderr.slice(-4_000)}`);
    return JSON.parse(stdout);
  })().finally(() => stopGroup(child, closed));
  terminal.child = child;
  return await awaitNestedRun(terminal);
}

test('a runner refusal in a sharded landing is handled by its class [C7,V4]', { timeout: 300_000 }, async (t) => { // budget: five bounded landings on one fixture.
  const box = fixture();
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  scenario(box, 'green');
  // The pin covers untracked contents, not only their names: a same-name replacement changes it.
  const loose = join(box.repo, 'loose.txt');
  writeFileSync(loose, 'first\n');
  const before = landingSource(box.repo);
  writeFileSync(loose, 'second\n');
  assert.notEqual(landingSource(box.repo).fingerprint, before.fingerprint, 'an untracked file with new content changes the pin');
  rmSync(loose);
  const rerunLine = /^landing shard (\d\/\d): runner fixture-host failed mid-shard; rerunning shard \1 locally$/mu;

  // 1. A lost host or transport reruns the shard locally, named.
  const dropped = await landingWithRunnerAnswer(box, 'DROPPED', 3, 120_000);
  assert.equal(dropped.isGreen, true, dropped.output);
  assert.match(dropped.output, rerunLine);
  assert.match(dropped.output, /attempt 1 on fixture-host: infrastructure \(runner transport lost\)/u);

  // 2. Changed source: the code under test drifted, so the landing fails by name with no retry.
  const drifted = await landingWithRunnerAnswer(box, 'RUNNER_SOURCE_CHANGED', 3, 120_000);
  assert.equal(drifted.isGreen, false, drifted.output);
  assert.match(drifted.output, /attempt 1 on fixture-host: refused \(runner refused: RUNNER_SOURCE_CHANGED\) in \d+ ms$/mu);
  assert.match(drifted.output, /^landing shard \d\/3: runner fixture-host refused it: \[RUNNER_SOURCE_CHANGED\] runner fixture-host answered/mu);
  assert.doesNotMatch(drifted.output, rerunLine, 'changed source is never retried');
  assert.equal(drifted.calls.length, 1);
  assert.equal(drifted.profile.shards.filter(shard => shard.status === 'stopped').length, 2, 'the other shards stop');

  // 3. Unverified cleanup reruns locally but takes the host out of this landing: no more shards go to it.
  const unverified = await landingWithRunnerAnswer(box, 'RUNNER_CLEANUP_TIMEOUT', 4, 150_000);
  assert.equal(unverified.isGreen, true, unverified.output);
  assert.match(unverified.output, rerunLine);
  // The quarantine and its inspect instruction come before the shard is retried anywhere.
  assert.ok(unverified.output.indexOf('quarantined for the rest of this landing') < unverified.output.search(rerunLine),
    `the host is quarantined before the retry\n${unverified.output}`);
  assert.match(unverified.output, /^landing runner fixture-host quarantined for the rest of this landing: \[RUNNER_CLEANUP_TIMEOUT\] .*inspect job fixture-job under its runner namespace before another run$/mu);
  assert.deepEqual(unverified.calls, ['fixture-host'], 'the quarantined host gets no second shard');
  assert.deepEqual(unverified.profile.quarantined.map(entry => entry.host), ['fixture-host']);
  assert.ok(unverified.profile.shards.filter(shard => shard.status === 'green').every(shard => shard.host === 'local'));

  // 4. A setup the runner's own pool refused (#690) reruns locally, with the code and host in the log.
  const setup = await landingWithRunnerAnswer(box, 'RUNNER_SETUP_REFUSED', 3, 120_000);
  assert.equal(setup.isGreen, true, setup.output);
  assert.match(setup.output, rerunLine);
  assert.match(setup.output, /attempt 1 on fixture-host: infrastructure \(runner refused: RUNNER_SETUP_REFUSED\)/u);
  assert.match(setup.output, /^landing shard \d\/3: runner fixture-host refused it: \[RUNNER_SETUP_REFUSED\]/mu);

  // 5. A refusal this landing does not know fails closed: red, named, and never silently retried.
  const unknown = await landingWithRunnerAnswer(box, 'RUNNER_SOMETHING_NEW', 3, 120_000);
  assert.equal(unknown.isGreen, false, unknown.output);
  assert.match(unknown.output, /attempt 1 on fixture-host: refused \(runner refused: RUNNER_SOMETHING_NEW\)/u);
  assert.doesNotMatch(unknown.output, rerunLine);

  // 6. A transport-loss rerun runs only the landing's pinned source: when the checkout changed
  // under the landing, the rerun refuses by name instead of testing other code.
  const edited = join(box.repo, 'test/f.test.js');
  const original = readFileSync(edited, 'utf8');
  try {
    const moved = await landingWithRunnerAnswer(box, 'DROPPED_AFTER_EDIT', 3, 120_000);
    assert.equal(moved.isGreen, false, moved.output);
    assert.match(moved.output, /^landing shard \d\/3: \[LANDING_SOURCE_CHANGED\] the checkout changed from the landing's pinned source [0-9a-f]{12} /mu);
    assert.match(moved.output, /: refused \(landing refused: LANDING_SOURCE_CHANGED\) in \d+ ms$/mu);
    assert.doesNotMatch(moved.output, /attempt 2 on local: green/u, 'no green result comes from the changed checkout');
  } finally { writeFileSync(edited, original); }
});

/** Whether a pid still names a live process; a permission error still means it exists. */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

test('a stopped landing shard drains its detached descendant [C7,V4]', { timeout: 120_000 }, async (t) => { // budget: one stopped two-shard landing plus its owned-process sweep.
  const box = fixture({ runner: false });
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  scenario(box, 'green');
  const ready = join(box.dir, 'detached-child-ready.json');
  const survived = join(box.dir, 'detached-child-survived');
  // The grandchild leaves the shard's process group and session, then writes its marker later.
  const childCode = [
    "import { writeFileSync } from 'node:fs';",
    'const writeAt = Date.now() + 3000;',
    `writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, writeAt }));`,
    `setTimeout(() => writeFileSync(${JSON.stringify(survived)}, 'survived'), writeAt - Date.now());`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const failing = `import { test } from 'node:test';
import { existsSync } from 'node:fs';
test('fail once the other shard owns its detached child', async () => {
  while (!existsSync(${JSON.stringify(ready)})) await new Promise(resolve => setTimeout(resolve, 25));
  throw new Error('deliberate first shard failure');
});
`;
  const owner = `import { test } from 'node:test';
import { spawn } from 'node:child_process';
test('own a detached child', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childCode)}], { detached: true, stdio: 'ignore' });
  child.unref();
  await new Promise(resolve => setTimeout(resolve, 60_000));
});
`;
  // Two shards: a.test.js alone fails, b.test.js owns the detached grandchild.
  for (const name of NAMES.slice(2)) rmSync(join(box.repo, `test/${name}.test.js`));
  writeFileSync(join(box.repo, 'test/a.test.js'), failing);
  writeFileSync(join(box.repo, 'test/b.test.js'), owner);
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ gate: fixtureGate(NAMES.slice(0, 2)), landingShards: 2 }));
  git(box.repo, box.env, 'add', '-A');
  git(box.repo, box.env, 'commit', '-q', '-m', 'test: a shard owns a detached descendant');
  let pid = null;
  try {
    const result = await landingGate(box, 'stopped shard with a detached descendant', 90_000);
    assert.equal(result.isGreen, false, result.output);
    assert.ok(existsSync(ready), 'the detached grandchild started before the stop');
    ({ pid } = JSON.parse(readFileSync(ready, 'utf8')));
    assert.equal(alive(pid), false, `no process from the stopped shard survives the landing\n${result.output}`);
    assert.doesNotMatch(result.output, /LANDING_SHARD_CLEANUP_UNVERIFIED/u, 'its cleanup was verified');
    assert.equal(existsSync(survived), false, 'the stopped grandchild never wrote its marker');
  } finally {
    // Only the fixture's own recorded grandchild is ever signalled here.
    if (pid) await stopGroup({ pid }, Promise.resolve());
  }
});

for (const count of [1, 3]) test(`collect-all retains two real failures and later green files with ${count} shard(s) [C7,V4]`, { timeout: 90_000 }, async t => {
  const box=fixture({runner:false});
  t.after(()=>rmSync(box.dir,{recursive:true,force:true}));
  writeFileSync(join(box.repo,'pullboard.json'),JSON.stringify({gate:fixtureGate(),landingShards:count}));
  if(git(box.repo,box.env,'status','--porcelain','pullboard.json').trim()) {
    git(box.repo,box.env,'add','pullboard.json');git(box.repo,box.env,'commit','-q','-m','test: collect-all shard count');
  }
  box.collectAll=true;
  scenario(box,'collect-all');
  const result=await landingGate(box,`collect both reds ${count}`,60_000);
  assert.equal(result.isGreen,false,'complete collection never turns red green');
  assert.equal(result.collectAllComplete,true,'actual native runner reports all planned files complete despite both failures');
  for(const name of ['a','b']) {
    assert.match(result.output,new RegExp(`not ok[^\\n]*fixture file ${name}`,'u'),result.output);
    assert.match(result.output,new RegExp(`collect-all deliberate failure ${name}`,'u'),result.output);
    assert.match(result.output,new RegExp(`test/${name}\\.test\\.js`,'u'),result.output);
  }
  assert.deepEqual(marks(box,'.finished').map(name=>name.split('.')[0]).sort(),['c','d','e','f'],
    'later green bodies actually finish; neither an abort nor omitted body counts as collected');
  assert.doesNotMatch(result.output,/Landing gate stopped early|attempt \d+ on \S+: stopped/u);
  if(count>1) {
    assert.equal(result.profile.landingShards.shards.some(row=>row.status==='stopped'),false);
    assert.equal(result.profile.landingShards.files.length,6);
  }
});


test('a collect-all shard cancelled by its owner reports drained but incomplete [C7,V4]', {timeout:90_000}, async t => {
  const box=fixture({runner:false});
  t.after(()=>rmSync(box.dir,{recursive:true,force:true}));
  const ready=join(box.dir,'collect-cancel-ready');
  const source=`import {test} from 'node:test';import {writeFileSync} from 'node:fs';test('cancelled collection body',async()=>{writeFileSync(${JSON.stringify(ready)},'ready');await new Promise(r=>setTimeout(r,60000));});\n`;
  writeFileSync(join(box.repo,'test/a.test.js'),source);
  for(const name of NAMES.slice(1))rmSync(repoPath(box.repo, `test/${name}.test.js`));
  git(box.repo,box.env,'add','-A');git(box.repo,box.env,'commit','-q','-m','test: real collect-all cancellation');
  const gateUrl=pathToFileURL(join(box.repo,'packages/gate/index.js')).href;
  const resourceUrl=pathToFileURL(join(box.repo,'packages/resources/index.js')).href;
  const reportUrl=pathToFileURL(join(box.repo,'packages/gate/index.js')).href;
  const id='11111111-1111-4111-8111-111111111111';
  const program=`import {spawn} from 'node:child_process';import {once} from 'node:events';
import {withGateSlot} from ${JSON.stringify(gateUrl)};
${executionServicesSource(gateUrl)}import {gateSlotEnvironment} from ${JSON.stringify(resourceUrl)};
import {parseCollectionReports} from ${JSON.stringify(reportUrl)};
await withGateSlot(process.cwd(),async lease=>{
 const child=spawn(process.execPath,['packages/gate/src/io/run/tests.js','test/a.test.js'],{cwd:process.cwd(),env:{...process.env,...gateSlotEnvironment(lease),PULLBOARD_LANDING_RUN:'1',PULLBOARD_LANDING_SHARD:'1/1',PULLBOARD_LANDING_COLLECT_ALL:'1',PULLBOARD_LANDING_COLLECTION_ID:${JSON.stringify(id)}},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const closed=once(child,'close');
 process.once('message',()=>child.kill('SIGTERM'));
 process.send({runner:child.pid});
 const[code,signal]=await closed;
 const report=parseCollectionReports(output,{id:${JSON.stringify(id)},scope:'shard',shard:'1/1',plannedFiles:['test/a.test.js'],requireComplete:false});
 process.send({terminal:true,code,signal,report,output});
},{ executionServices,remote:false,browser:true,agent:'collect-cancel-fixture'});process.disconnect();`;
  const child=spawn(process.execPath,['--input-type=module','-e',program],{cwd:box.repo,env:box.env,detached:true,stdio:['ignore','pipe','pipe','ipc']});
  const messages=[];child.on('message',m=>messages.push(m));child.stdout.resume();let stderr='';child.stderr.on('data',b=>stderr+=b);const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  try {
    const deadline=Date.now()+30_000;
    while(!existsSync(ready)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(existsSync(ready),true,'actual test body started before owner cancellation');
    assert.ok(messages.some(m=>Number.isSafeInteger(m.runner)),'owned exact runner identified');
    child.send('stop-owned-runner');
    const ended=await closed;assert.equal(ended.code,0,stderr);assert.equal(ended.signal,null,stderr);
    const terminal=messages.find(m=>m.terminal);assert.ok(terminal,stderr);
    assert.equal(terminal.code,1,terminal.output);assert.equal(terminal.signal,null,terminal.output);
    assert.ok(terminal.report,'native false report survives actual cancellation');
    assert.equal(terminal.report.complete,false,terminal.output);
    assert.equal(terminal.report.cleanupVerified,true,'cleanup and completed coverage are separate facts');
    // A file may publish a terminal cancelled summary; that does not make collection complete.
  } finally {
    await stopGroup(child, closed);
  }
});

test('a shard the landing stops blames none of its aborted in-flight files [C7,V4]', {timeout:90_000}, async t => {
  const box=fixture({runner:false});
  t.after(()=>rmSync(box.dir,{recursive:true,force:true}));
  const ready=join(box.dir,'stop-ready');
  const source=`import {test} from 'node:test';import {writeFileSync} from 'node:fs';test('in-flight body [C7]',async()=>{writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);await new Promise(()=>{});});\n`;
  writeFileSync(join(box.repo,'test/a.test.js'),source);
  for(const name of NAMES.slice(1))rmSync(repoPath(box.repo, `test/${name}.test.js`));
  git(box.repo,box.env,'add','-A');git(box.repo,box.env,'commit','-q','-m','test: a shard stopped mid-file');
  const gateUrl=pathToFileURL(join(box.repo,'packages/gate/index.js')).href;
  const resourceUrl=pathToFileURL(join(box.repo,'packages/resources/index.js')).href;
  const program=`import {spawn} from 'node:child_process';import {once} from 'node:events';
import {withGateSlot} from ${JSON.stringify(gateUrl)};
${executionServicesSource(gateUrl)}import {gateSlotEnvironment} from ${JSON.stringify(resourceUrl)};
await withGateSlot(process.cwd(),async lease=>{
 const child=spawn(process.execPath,['packages/gate/src/io/run/tests.js','test/a.test.js'],{cwd:process.cwd(),env:{...process.env,...gateSlotEnvironment(lease),PULLBOARD_LANDING_RUN:'1',PULLBOARD_LANDING_SHARD:'1/2'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const closed=once(child,'close');
 process.once('message',()=>child.kill('SIGTERM'));
 process.send({runner:child.pid});
 const[code,signal]=await closed;
 process.send({terminal:true,code,signal,output});
},{ executionServices,remote:false,browser:true,agent:'shard-stop-fixture'});process.disconnect();`;
  const child=spawn(process.execPath,['--input-type=module','-e',program],{cwd:box.repo,env:box.env,detached:true,stdio:['ignore','pipe','pipe','ipc']});
  const messages=[];child.on('message',m=>messages.push(m));child.stdout.resume();let stderr='';child.stderr.on('data',b=>stderr+=b);const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  try {
    // The body writes its marker once it runs; wait on the directory's change events, not on a timer.
    await new Promise(resolve=>{const watcher=watch(box.dir,()=>{if(existsSync(ready)){watcher.close();resolve();}});if(existsSync(ready)){watcher.close();resolve();}});
    assert.equal(existsSync(ready),true,'the file was running when the landing stopped the shard');
    child.send('stop-shard');
    const ended=await closed;assert.equal(ended.code,0,stderr);
    const terminal=messages.find(m=>m.terminal);assert.ok(terminal,stderr);
    assert.equal(terminal.code,1,terminal.output);
    assert.match(terminal.output,/stopped by the landing after another shard failed/u,terminal.output);
    assert.doesNotMatch(terminal.output,/Landing gate stopped early after/u,'the aborted in-flight file is never named as the shard\'s failure');
  } finally {
    await stopGroup(child, closed);
  }
});
