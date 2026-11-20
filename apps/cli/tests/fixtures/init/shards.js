/** Shared fixture for the landing shard journeys: a throwaway repository, an SSH stand-in runner and a landing gate [C7,V4]. */
import { executionServicesSource } from '../gate/execution.js';
import { repoPath } from '../../../../../packages/kernel/light.js';
import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import { awaitNestedRun } from '../../../../../packages/gate/heavy.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../child.js';
import { stopGroup } from '../runner/group.js';
import { installRegistrationProbeStandIn } from '../runner/ssh.js';

export const SOURCE = resolve(import.meta.dirname, '../../../../..');
export const BIN = join(SOURCE, 'apps/cli/pullboard.js');
export const HOST = 'fixture-host';
export const NAMES = ['a', 'b', 'c', 'd', 'e', 'f'];

/** The full published copy contains unrelated docs tests; this fixture gates exactly its original probe universe. */
export function fixtureGate(names = NAMES) { return 'node apps/cli/src/io/run/tests.js ' + names.map(name => `test/${name}.test.js`).join(' '); }


/** Run Git in a fixture repository and fail with its context. */
export function git(cwd, env, ...args) {
  const result = runFixtureChild('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  return result.stdout.trim();
}

/**
 * Make a local ssh stand-in that runs the worker command in a second private machine home.
 * With `dropOnce`, the first session alive when a test file starts on the runner kills the worker,
 * the way a runner that loses power mid-shard looks to the controller.
 */
export function installSshStandIn({ bin, worker, home, machineHome, markers, dropOnce }) {
  const source = `#!/usr/bin/env node
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const argv = process.argv.slice(2);
const divider = argv.indexOf('--');
const host = argv[divider + 1];
const remoteCommand = argv[divider + 2];
if (host !== ${JSON.stringify(HOST)}) process.exit(255);
// A control call (ssh -O check, or a master start) carries no remote command: it ends at once, so it never waits on a drop that needs a started shard.
if (!remoteCommand) process.exit(0);
const dropFlag = ${JSON.stringify(dropOnce ?? '')};
const drop = Boolean(dropFlag);
const env = { PATH: process.env.PATH, HOME: ${JSON.stringify(home)}, TMPDIR: process.env.TMPDIR,
  PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: ${JSON.stringify(home)}, PULLBOARD_MACHINE_HOME: ${JSON.stringify(machineHome)}, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
const child = spawn('/bin/sh', ['-c', remoteCommand], { cwd: ${JSON.stringify(worker)}, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.pipe(child.stdin);
if (drop) {
  const timer = setInterval(() => {
    if (!readdirSync(${JSON.stringify(markers)}).some(name => name.endsWith('.runner.started'))) return;
    clearInterval(timer);
    // Only the session that was alive when a test file started on the runner is dropped, and only once; the connect
    // and history sessions before it end on their own and must not use up the drop.
    if (existsSync(dropFlag)) return;
    writeFileSync(dropFlag, 'dropped\\n');
    // The worker leads its own process group, so the whole tree it started dies with it, as on a lost runner.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
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
export function fixtureTestFile(name, { markers, mode }) {
  return `import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
const name = ${JSON.stringify(name)};
const host = process.cwd().includes('worker-home') ? 'runner' : 'local';
const mode = existsSync(${JSON.stringify(mode)}) ? readFileSync(${JSON.stringify(mode)}, 'utf8').trim() : 'green';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('fixture file ' + name, async () => {
  writeFileSync(${JSON.stringify(markers)} + '/' + name + '.' + host + '.started', '');
  // The dropped runner must receive a shard before the local slots can take them all: hold local files until it started one (a stand-in runner call counts).
  if ((mode === 'drop' || mode === 'green-runner') && host === 'local') {
    for (let waited = 0; waited < 60_000 && !readdirSync(${JSON.stringify(markers)}).some(file => file.endsWith('.runner.started')); waited += 100) await sleep(100);
  }
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
export function fixture({ runner = true, repoNames = ['repo'] } = {}) {
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
    ...process.env, HOME: home, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
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
export function scenario(box, mode, { dropOnce } = {}) {
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
export async function landingGate(box, label, deadlineMs, repo = box.repo) {
  return await awaitNestedRun(startLandingGate(box, label, deadlineMs, repo));
}

/** Start a landing immediately; callers may start several before lending their one place serially. */
export function startLandingGate(box, label, deadlineMs, repo = box.repo) {
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
export function mergedFiles(output) {
  const files = {};
  for (const match of output.matchAll(/^# landing file (\d+\/\d+) (\S+) (\d+|-) (.+)$/gmu)) {
    assert.equal(files[match[4]], undefined, `${match[4]} is listed once`);
    files[match[4]] = { shard: match[1], host: match[2] };
  }
  return files;
}

/** Markers left by the fixture files, as a sorted list. */
export function marks(box, suffix) {
  return readdirSync(box.markers).filter(name => name.endsWith(suffix)).sort();
}

/**
 * Run a sharded landing in a child process where the SSH round trip is replaced by one that answers
 * every runner call with `answer` (a refusal code, or DROPPED for a lost transport).
 */
export async function landingWithRunnerAnswer(box, answer, count, deadlineMs) {
  const url = name => JSON.stringify(pathToFileURL(repoPath(SOURCE, name)).href);
  const files = NAMES.map(name => `./test/${name}.test.js`);
  const script = `const { runLandingShards } = await import(${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/landing/index.js')).href)});
const { parseProcessCensus } = await import(${url('packages/kernel/src/logic/census.js')});
const { landingShardProfile } = await import(${url('packages/gate/index.js')});
const { Refused } = await import(${url('packages/kernel/index.js')});
const { RunnerDropped } = await import(${url('packages/gate/light.js')});
const { appendFileSync, writeFileSync } = await import('node:fs');
const answer = ${JSON.stringify(answer)};
const calls = [];
const remoteRun = async (_root, _command, options) => {
  calls.push(options.runner.host);
  writeFileSync(${JSON.stringify(join(box.markers, 'call.runner.started'))}, '');
  if (answer === 'DROPPED') throw new RunnerDropped(options.runner.host);
  if (answer === 'DROPPED_AFTER_EDIT') {
    // The checkout moves on while the landing runs: a rerun must not test this source instead.
    appendFileSync(${JSON.stringify(join(box.repo, 'test/f.test.js'))}, '\\n// edited while the landing ran\\n');
    throw new RunnerDropped(options.runner.host);
  }
  throw new Refused(answer, 'runner ' + options.runner.host + ' answered ' + answer + '; inspect job fixture-job under its runner namespace before another run');
};
const chunks = [];
const result = await runLandingShards({ parseProcessCensus, root: ${JSON.stringify(box.repo)}, runner: ${JSON.stringify(join(box.repo, 'apps/cli/src/io/run/tests.js'))},
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

/** Whether a pid still names a live process; a permission error still means it exists. */
export function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
