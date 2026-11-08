import { flakeQuarantines as nativeFlakeQuarantines } from '../packages/flakes/index.js';
import { gateRuns as nativeGateRuns } from '../packages/flakes/index.js';
import { recordGateRun as nativeRecordGateRun } from '../packages/flakes/index.js';
/**
 * The gate's digest (V10): what an agent reads of a red run. And submit's own run of the gate (V16):
 * no stamp stands in for it, and the tree must hold still while it runs.
 *
 * @pullboard-world-pin the clock-budget case copies the shipped scanner entry into its fixture.
 */
import { landingPorts } from './landing-ports-fixture.js';
import { executionServices } from './gate-execution-fixture.js';
import { copyPackageFiles } from '../packages/runners/index.js';
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, runFixtureChild as spawnSync, runFixtureChild, runFixtureGit, startFixtureChild as spawn } from './fixture-child.js';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as store from '../src/board.js';
import { openBoard } from '../apps/lib/index.js';
import { main as cli } from './native-cli-fixture.js';
import { digestOf, testConcurrency } from '../packages/gate/index.js';
import { runGate } from '../packages/gate/index.js';
import { liveWaiverProjection } from '../packages/landing/index.js';
import { waiverLine } from '../packages/landing/index.js';
import { waivedFailures } from '../packages/landing/index.js';
import { applyEngineMove } from '../packages/state/index.js';
import { prepareEngineMove } from '../packages/state/index.js';
import { mainPolicy } from '../packages/sandbox/index.js';
import { ENGINE_VERSION } from '../packages/state/index.js';
import { submitFixture } from './board-submit-fixture.js';
import { createE2eHelpers, FIXTURE_MODEL } from './e2e-helpers.js';
import { BROWSER_SLOT_HELD_ENV, GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV } from '../packages/resources/index.js';
import { fixtureAdd } from './testkit-fixture.js';
import { joinFixtureSeat } from './testkit-fixture.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const PRIVATE_WORKER = resolve(import.meta.dirname, '../apps/runner/src/shell/private-check-worker.js');

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Read the real file bodies' start/finish records to measure overlap without sampling process names. */
function fileOverlap(file) {
  const active = new Map();
  const starts = [];
  let files = 0, browser = 0;
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const event = JSON.parse(line);
    if (event.start) {
      assert.equal(active.has(event.id), false, 'a file begins once');
      active.set(event.id, event.browser);
      starts.push(event.id);
      files = Math.max(files, active.size);
      browser = Math.max(browser, [...active.values()].filter(Boolean).length);
    } else {
      assert.equal(active.delete(event.id), true, 'every finish has a start');
    }
  }
  assert.equal(active.size, 0, 'every selected file finishes');
  return { files, browser, starts };
}

test('the landing gate bounds its own concurrency [C7]', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-file-caps-')));
  dirs.push(root);
  copyPackageFiles(resolve(import.meta.dirname, '..'), root);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  const config = join(root, 'pullboard.json');
  assert.deepEqual(testConcurrency(root, 7), { files: 7, browser: 2 }, 'the default file budget is the detected core budget');
  const selected = [];
  for (let id = 0; id < 9; id += 1) {
    const browser = id < 4;
    const folder = join(root, 'test', browser ? 'cockpit' : 'ordinary');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `overlap-${id}.test.js`);
    selected.push(file);
    writeFileSync(file, `import {appendFileSync} from 'node:fs';
import {test} from 'node:test';
/** Keep controlled work alive briefly so concurrent file bodies leave overlapping records. */
test('record real file ${id} [C7]', async () => {
  appendFileSync(process.env.PULLBOARD_CAP_CAPTURE, JSON.stringify({start:true,id:${id},browser:${browser}})+'\\n');
  await new Promise(resolve => setTimeout(resolve, 200)); // budget: controlled fixture work, not a readiness deadline or production wait.
  appendFileSync(process.env.PULLBOARD_CAP_CAPTURE, JSON.stringify({start:false,id:${id}})+'\\n');
});\n`);
  }
  for (const setting of [{ files: 3, browser: 2 }, { files: 2, browser: 1 }]) {
    writeFileSync(config, JSON.stringify({ testConcurrency: setting }));
    assert.deepEqual(testConcurrency(root, 7), setting, 'pullboard.json overrides the shared policy');
    const cases = [
      { name: 'spawnSync explicit large integer', args: ['--test-concurrency=9'], landing: false },
      { name: 'landing default', args: [], landing: true },
      { name: 'landing true override', args: ['--test-concurrency=true'], landing: true },
      { name: 'landing large integer override', args: ['--test-concurrency=9'], landing: true },
      { name: 'landing serial override', args: ['--test-concurrency=false'], landing: true, serial: true },
    ];
    for (const [caseIndex, example] of cases.entries()) {
      const capture = join(root, `overlap-${setting.files}-${caseIndex}.jsonl`);
      const env = { ...process.env, PULLBOARD_CAP_CAPTURE: capture,
        PULLBOARD_MACHINE_HOME: join(root, `machine-${setting.files}-${caseIndex}`) };
      env.PULLBOARD_LANDING_RUN = example.landing ? '1' : '0';
      const result = runFixtureChild(process.execPath, [join(root, 'bin/run-tests.js'), ...example.args, ...selected], {
        cwd: root, env, encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${example.name}: ${result.stdout}${result.stderr}`);
      const peak = fileOverlap(capture);
      assert.ok(peak.files <= setting.files, `${example.name}: file-body overlap ${peak.files} exceeds ${setting.files}`);
      assert.ok(peak.browser <= setting.browser, `${example.name}: browser-file overlap ${peak.browser} exceeds ${setting.browser}`);
      if (example.serial) assert.equal(peak.files, 1, 'false keeps the native runner serial');
      assert.deepEqual(peak.starts.sort((a, b) => a - b), Array.from({ length: 9 }, (_, id) => id),
        `${example.name}: every selected file runs once`);
      assert.match(result.stdout, /# tests 9\b/u);
      assert.match(result.stdout, /# fail 0\b/u);
    }
  }
  writeFileSync(config, JSON.stringify({ testConcurrency: { files: 3, browser: 2 } }));
  for (const value of ['4294967296', '9'.repeat(400)]) {
    const capture = join(root, `invalid-concurrency-${value.length}.jsonl`);
    const result = runFixtureChild(process.execPath, [join(root, 'bin/run-tests.js'),
      `--test-concurrency=${value}`, ...selected], {
      cwd: root, env: { ...process.env, PULLBOARD_LANDING_RUN: '1', PULLBOARD_CAP_CAPTURE: capture,
        PULLBOARD_MACHINE_HOME: join(root, `machine-invalid-${value.length}`) }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, 'an invalid native concurrency value is refused');
    assert.match(result.stderr, /invalid --test-concurrency value/u);
    assert.equal(existsSync(capture), false, 'invalid concurrency is refused before any file body runs');
  }
  let isolationCase = 0;
  for (const flag of ['--test-isolation', '--test_isolation', '--experimental-test-isolation',
    '--experimental_test_isolation', '--experimental_test-isolation', '--experimental-test_isolation']) {
    for (const args of [[`${flag}=none`], [flag, 'none']]) {
      const capture = join(root, `isolation-${isolationCase++}.jsonl`);
      const result = runFixtureChild(process.execPath, [join(root, 'bin/run-tests.js'), ...args, selected.at(-1)], {
        cwd: root, env: { ...process.env, PULLBOARD_CAP_CAPTURE: capture,
          PULLBOARD_MACHINE_HOME: join(root, 'machine-isolation') }, encoding: 'utf8',
      });
      assert.notEqual(result.status, 0, `${args.join(' ')} must refuse non-isolated test files`);
      assert.match(result.stderr, /bounded browser test files require process isolation/u);
      assert.equal(existsSync(capture), false, 'a refused isolation mode never starts a test-file body');
    }
  }
  writeFileSync(config, JSON.stringify({ testConcurrency: { browser: 3 } }));
  assert.throws(() => testConcurrency(root, 7), /browser must be 1 or 2/);
});

test('the gate stops before the suite on a missing clock-budget comment [C7]', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-gate-clock-budget-')));
  dirs.push(root);
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'test'));

  const actualPackage = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
  const gateScript = actualPackage.scripts.gate;
  const fixturePackage = { ...actualPackage, scripts: { ...actualPackage.scripts, test: 'node test/suite-sentinel.js' } };
  assert.equal(fixturePackage.scripts.gate, gateScript, 'the real package gate command is preserved verbatim');
  writeFileSync(join(root, 'package.json'), JSON.stringify(fixturePackage, null, 2) + '\n');
  copyFileSync(resolve(import.meta.dirname, 'wall-clock-budgets.js'), join(root, 'test/wall-clock-budgets.js'));
  // The shipped scanner entry delegates to the gate package after the cells move.
  const scanner = join(root, 'packages/gate/src/shell');
  mkdirSync(scanner, { recursive: true });
  copyFileSync(resolve(import.meta.dirname, '../packages/gate/src/shell/wall-clock-budgets.js'), join(scanner, 'wall-clock-budgets.js'));
  writeFileSync(join(root, 'packages/gate/index.js'), "export { fixedWallMargins, wallClockViolations } from './src/shell/wall-clock-budgets.js';\n");
  // The scanner lists tracked files through the git package; the fixture supplies a plain git launcher for it.
  mkdirSync(join(root, 'packages/git'), { recursive: true });
  writeFileSync(join(root, 'packages/git/index.js'), "import { execFileSync } from 'node:child_process';\nexport const gitExecFileSync = (args, options) => execFileSync('git', args, options);\n");
  writeFileSync(join(root, 'bin/pullboard.js'), `if (process.argv.slice(2).join(' ') !== 'spec check') process.exit(2);
process.stdout.write('fixture spec check reached\\n');
`);
  const suiteMarker = join(root, 'suite-ran');
  writeFileSync(join(root, 'test/suite-sentinel.js'), `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(suiteMarker)}, 'ran');
`);
  const missingBudget = join(root, 'test/missing-budget.test.js');
  writeFileSync(missingBudget, `import assert from 'node:assert/strict';
const started = Date.now();
assert.ok(Date.now() - started < 500, 'planted assertion without a budget comment');
`);

  const env = { ...process.env, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  runFixtureGit(['add', '-A'], { cwd: root, env });

  const refused = runFixtureChild('npm', ['run', 'gate'], { cwd: root, env, encoding: 'utf8' });
  const refusalOutput = `${refused.stdout ?? ''}\n${refused.stderr ?? ''}`;
  assert.notEqual(refused.status, 0, `${refused.context}\n${refusalOutput}`);
  assert.match(refusalOutput, /test\/missing-budget\.test\.js:3: literal elapsed-time margin/u,
    'the real scanner reports the tracked file and exact line');
  assert.match(refusalOutput, /elapsed-time margin|clock budget|wall-clock/u,
    'the refusal explains that the failure is a clock-budget violation');
  assert.ok(refused.elapsedMs < 5000, `${refused.elapsedMs}ms; scanner must refuse before the suite.`); // budget: declared #653 static-refusal ceiling is 5000ms.
  assert.equal(existsSync(suiteMarker), false, 'the suite sentinel did not run after the scanner refused');

  rmSync(missingBudget);
  runFixtureGit(['add', '-u'], { cwd: root, env });
  const clean = runFixtureChild('npm', ['run', 'gate'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(clean.status, 0, `${clean.context}\n${clean.stdout ?? ''}\n${clean.stderr ?? ''}`);
  assert.equal(existsSync(suiteMarker), true, 'a clean scanner result continues into the suite');
});

/** The persona name the gate fixtures join under. */
const FIXTURE_AGENT = 'Test Agent';

/**
 * A repo whose coordinator holds item #1, with this gate. Every run of the gate first adds a line
 * to runs.log beside the repo, so a test can count the runs.
 *
 * @param {string} gate
 * @param {string} [check]
 */
function repoWithGate(gate, check = '') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-gate-')));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'home'),
  };
  // The fixture's checks and gates are their own test runs, not children of this one.
  delete env.NODE_TEST_CONTEXT;
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: `echo run >> ../runs.log; ${gate}`, lanes: { build: { owns: ['WORK', 'RED', 'fixtures/'] } } }));
  writeFileSync(join(repo, 'SPEC.md'), '# Demo\n\n## G · Goals\n- G1 [approved, must] It works. | gate: test\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: a spec');
  const added = run('add', 'build', 'Work', '--route', 'mid', '--brief', 'Files:\n- fixtures/WORK\n\nTest:\nthe fixture gate behaves as asserted.', '--criterion', 'The gate behaves as asserted.', ...(check ? ['--check', check, '--wait'] : ['--check', 'true']));
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  // Submissions need their own committed delta; main itself is not an item change. Accepted main is the primary
  // checkout's HEAD, so the item work lives in a linked worktree and the primary checkout stays on main.
  const work = join(dir, 'work');
  git('worktree', 'add', '-q', '-b', 'coordinator/item-1', work);
  const workGit = (...args) => runFixtureGit(args, { cwd: work, env });
  writeFileSync(join(work, 'WORK'), 'item change\n');
  workGit('add', 'WORK');
  workGit('commit', '-q', '-m', 'chore: make the fixture item change');
  const runs = () => {
    try {
      return readFileSync(join(dir, 'runs.log'), 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const runAt = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: work, env, encoding: 'utf8' });
  const joined = runAt('join', 'build', '--model', FIXTURE_AGENT);
  assert.equal(joined.status, 0, `${joined.stdout}${joined.stderr}`);
  const claimed = runAt('claim', '1');
  assert.equal(claimed.status, 0, `${claimed.stdout}${claimed.stderr}`);
  return { dir, repo: work, primary: repo, env, git: workGit, primaryGit: git, run: runAt, runs };
}

test('pullboard gate status refuses instead of running the gate [C7,P4]', async () => {
  const box = repoWithGate('echo run >> ../runs.log');
  for (const name of [BROWSER_SLOT_HELD_ENV, GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV]) delete box.env[name];
  assert.equal(box.run('settings', 'gateSlots', '1').status, 0, 'the fixture uses the holder pool\'s single gate slot');
  const resourceModule = pathToFileURL(resolve(import.meta.dirname, '../packages/resources/index.js')).href;
  const holderSource = `import { takeResource } from ${JSON.stringify(resourceModule)};
const lease = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: process.cwd(), agent: 'gate-argument-holder' });
try {
  process.stdout.write('held\\n');
  process.stdin.setEncoding('utf8');
  for await (const line of process.stdin) if (line.trim() === 'release') break;
} finally { lease.release(); }
`;
  let holderRun;
  let holderClosed;
  let commandRun;
  let commandClosed;
  let holderResult;
  try {
    holderRun = spawn(process.execPath, ['--input-type=module', '-e', holderSource], {
      cwd: box.repo, env: box.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let holderOutput = '';
    holderRun.stdout.setEncoding('utf8');
    holderClosed = new Promise((resolveClosed) => holderRun.once('close', (status, signal) =>
      resolveClosed({ status, signal, stdout: holderOutput })));
    const holderReady = new Promise((resolveReady) => {
      holderRun.stdout.on('data', (part) => {
        holderOutput += part;
        if (holderOutput.includes('held\n')) resolveReady({ ready: true });
      });
      holderClosed.then((result) => resolveReady({ result }));
    });
    const ready = await holderReady;
    assert.equal(ready.ready, true, `the private gate holder did not start: ${JSON.stringify(ready.result ?? holderOutput)}`);

    for (const words of [['status'], ['run'], ['unexpected', 'word']]) {
      commandRun = spawn(process.execPath, [BIN, 'gate', ...words], {
        cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let commandOutput = '';
      let commandError = '';
      commandRun.stdout.setEncoding('utf8');
      commandRun.stderr.setEncoding('utf8');
      commandRun.stdout.on('data', (part) => { commandOutput += part; });
      commandRun.stderr.on('data', (part) => { commandError += part; });
      commandClosed = new Promise((resolveClosed) => commandRun.once('close', (status, signal) =>
        resolveClosed({ status, signal, stdout: commandOutput, stderr: commandError })));
      const queued = new Promise((resolveQueued) => {
        commandRun.stdout.on('data', () => {
          if (commandOutput.includes('gate waiting:')) resolveQueued({ queued: true });
        });
      });
      const outcome = await Promise.race([
        queued,
        commandClosed.then((result) => ({ result })),
      ]);
      if (outcome.queued) {
        commandRun.kill('SIGTERM');
        await commandClosed;
        assert.fail(`the unexpected words ${words.join(' ')} entered the held gate queue: ${commandOutput}`);
      }
      assert.equal(outcome.result.status, 1, `${outcome.result.stderr}\n${outcome.result.stdout}`);
      assert.match(outcome.result.stderr, /\[GATE_ARGUMENT\]/u);
      assert.match(outcome.result.stderr, /pullboard resources for status/u);
      assert.match(outcome.result.stderr, /pullboard gate with no extra words to run the gate/u);
      assert.equal(box.runs(), 0, 'a refused extra word never starts the configured gate');
      const gate = JSON.parse(box.run('resources', '--json').stdout).resources.find(({ name }) => name === 'gate');
      assert.deepEqual(gate?.holders.map(({ agent }) => agent) ?? [], ['gate-argument-holder']);
      assert.equal(gate?.line.length ?? 0, 0, 'the refused command never becomes a gate waiter');
    }
    for (const words of [['status'], ['run'], ['unexpected', 'word']]) {
      const result = box.run('gate', ...words, '--json');
      assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
      const { error } = JSON.parse(result.stdout);
      assert.equal(error.code, 'GATE_ARGUMENT');
      assert.equal(error.next, 'use pullboard resources for status, or pullboard gate with no extra words to run the gate');
      assert.equal(box.runs(), 0, 'JSON refusal never starts the configured gate');
      const gate = JSON.parse(box.run('resources', '--json').stdout).resources.find(({ name }) => name === 'gate');
      assert.deepEqual(gate?.holders.map(({ agent }) => agent) ?? [], ['gate-argument-holder']);
      assert.equal(gate?.line.length ?? 0, 0, 'the refused JSON command never becomes a gate waiter');
    }
  } finally {
    if (commandRun && commandRun.exitCode === null && commandRun.signalCode === null) {
      commandRun.kill('SIGTERM');
    }
    if (commandClosed) await commandClosed;
    if (holderRun) {
      if (holderRun.exitCode === null && holderRun.signalCode === null) holderRun.stdin.end('release\n');
      holderResult = await holderClosed;
    }
  }
  assert.equal(holderResult?.status, 0, JSON.stringify(holderResult));
});

test('gate before the first commit names the uncommitted config [I1,C7]', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-first-commit-')));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'home'),
  };
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const initialized = run('init', '--model', 'Test Coordinator');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  assert.equal(existsSync(join(repo, 'pullboard.json')), true, 'init wrote the coordinator config');

  const firstGate = run('gate', '--json');
  assert.equal(firstGate.status, 1, 'the gate cannot read a policy before the initial commit');
  const firstRefusal = JSON.parse(firstGate.stdout).error;
  assert.equal(firstRefusal.code, 'NO_POLICY');
  assert.match(firstRefusal.message, /pullboard\.json is not committed/u);
  assert.match(firstRefusal.message, /git add pullboard\.json/u, 'the refusal gives the concrete staging command');

  const committed = repoWithGate('true');
  committed.primaryGit('switch', '--detach', 'HEAD');
  const missingCoordinator = committed.run('gate', '--json');
  assert.equal(missingCoordinator.status, 1);
  const missingRefusal = JSON.parse(missingCoordinator.stdout).error;
  assert.equal(missingRefusal.code, 'NO_POLICY');
  assert.match(missingRefusal.message, /coordinator checkout is detached for review/u,
    'other genuine NO_POLICY failures keep their specific message');
});

test('gate after init in an existing repo says to commit the init files [I1,C7]', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-init-history-')));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'home'),
  };
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Existing repository\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'chore: create existing repository');
  assert.equal(run('init', '--model', 'Test Coordinator').status, 0);

  const refused = run('gate', '--json');
  assert.equal(refused.status, 1, 'the gate cannot read the policy until init files are committed');
  const refusal = JSON.parse(refused.stdout).error;
  assert.equal(refusal.code, 'NO_POLICY');
  const message = refusal.message;
  assert.match(message, /pullboard\.json and Pullboard's initialized setup files are uncommitted/u);
  assert.match(message, /git add(?: -f)? -- .*pullboard\.json/u, 'the refusal gives a scoped staging command');
  assert.match(message, /&& git commit -q -m "chore: set up pullboard"/u, 'the refusal explains the needed commit');
  for (const path of ['SPEC.md', 'DOCTRINE.md']) assert.ok(message.includes(path), message);
  assert.ok(!message.includes('README.md'), 'unrelated existing files are not included in the staging command');

  // The command the refusal prints is the one that fixes it.
  const fix = message.slice(message.indexOf('commit them before running the gate: ') + 'commit them before running the gate: '.length);
  // init installs hooks that call `pullboard`; a person has it installed, so the fixture provides it.
  const shims = join(dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} "$@"\n`, { mode: 0o755 });
  const applied = runFixtureChild('/bin/sh', ['-c', fix], { cwd: repo, env: { ...env, PATH: `${shims}:${env.PATH ?? ''}` }, encoding: 'utf8' });
  assert.equal(applied.status, 0, `${applied.stdout}${applied.stderr}`);
  const afterFix = run('gate', '--json');
  assert.notEqual(afterFix.stdout ? JSON.parse(afterFix.stdout).error?.code : undefined, 'NO_POLICY', 'the printed commit lets the gate read its policy');

  // A policy missing for any other reason keeps its own refusal.
  git('switch', '-q', '--detach', 'HEAD');
  const detached = run('gate', '--json');
  assert.equal(detached.status, 1);
  const otherMissing = JSON.parse(detached.stdout).error;
  assert.equal(otherMissing.code, 'NO_POLICY');
  assert.doesNotMatch(otherMissing.message, /uncommitted/u, 'a committed config never gets the commit-your-setup message');

  // Git metadata kept outside the project (git init --separate-git-dir) gets the same advice.
  const separate = join(dir, 'separate');
  mkdirSync(separate);
  const separateGit = (...args) => runFixtureGit(args, { cwd: separate, env });
  const separateRun = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: separate, env, encoding: 'utf8' });
  separateGit('init', '-q', '-b', 'main', '--separate-git-dir', join(dir, 'separate-metadata'));
  writeFileSync(join(separate, 'README.md'), '# Existing repository\n');
  separateGit('add', 'README.md');
  separateGit('commit', '-q', '-m', 'chore: create existing repository');
  assert.equal(separateRun('init', '--model', 'Test Coordinator').status, 0);
  const separateRefused = separateRun('gate', '--json');
  assert.equal(separateRefused.status, 1);
  const separateRefusal = JSON.parse(separateRefused.stdout).error;
  assert.equal(separateRefusal.code, 'NO_POLICY');
  assert.match(separateRefusal.message, /pullboard\.json and Pullboard's initialized setup files are uncommitted/u,
    'a separate Git directory still gets the commit-your-setup message');
  assert.ok(separateRefusal.message.includes('SPEC.md') && !separateRefusal.message.includes('README.md'), separateRefusal.message);
});

test('a digest keeps the failures and the end within its cap, however long one line is [V10]', () => {
  const digest = digestOf(`not ok 1 - ${'x'.repeat(3500)}\n${'ok\n'.repeat(50)}# fail 1\nsummary: 1 failed`);
  assert.ok(digest.length <= 3000, `${digest.length} characters`);
  assert.match(digest, /^not ok 1 - x+…\n/);
  assert.match(digest, /# fail 1\nsummary: 1 failed$/);
});

test('a digest of many failures stays within its cap and still ends with the summary [V10]', () => {
  const failures = Array.from({ length: 200 }, (_, n) => `not ok ${n} - ${'y'.repeat(250)}`).join('\n');
  const digest = digestOf(`${failures}\n# tests 200\n# fail 200`);
  assert.ok(digest.length <= 3000, `${digest.length} characters`);
  assert.match(digest, /^not ok 0 - /);
  assert.match(digest, /# tests 200\n# fail 200$/);
});

test('a digest keeps the lines that say why a test failed, and skips passing tests however named [V10]', () => {
  const tap = [
    '# Subtest: a lane cannot commit outside its folders',
    'ok 1 - a lane cannot commit outside its folders',
    '# Subtest: an error in the store is reported',
    'ok 2 - an error in the store is reported',
    '# Subtest: add returns the new number',
    'not ok 3 - add returns the new number',
    '  ---',
    "  location: '/repo/test/store.test.js:12:1'",
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    2 !== 1',
    '  expected: 1',
    '  actual: 2',
    '  ...',
    ...Array.from({ length: 30 }, (_, n) => `ok ${n + 4} - filler ${n}`),
    '# tests 33',
    '# pass 32',
    '# fail 1',
  ].join('\n');
  const digest = digestOf(tap);
  assert.doesNotMatch(digest, /cannot commit|error in the store/, 'passing tests are not failures');
  assert.match(digest, /^not ok 3 - add returns the new number\n/);
  assert.match(digest, /store\.test\.js:12:1/);
  assert.match(digest, / {4}2 !== 1\n {2}expected: 1\n {2}actual: 2/);
  assert.match(digest, /# fail 1$/);
});

test('submit runs the gate itself: a stamp written by hand never stands in for a red gate [V16]', () => {
  const box = repoWithGate('test ! -f RED');
  writeFileSync(join(box.repo, 'RED'), 'red\n');
  box.git('add', 'RED');
  box.git('commit', '-q', '-m', 'chore: turn the gate red');
  writeFileSync(resolve(box.repo, box.git('rev-parse', '--git-path', 'pullboard-gate-green')), `${box.git('rev-parse', 'HEAD^{tree}')}\n`);
  const refused = box.run('submit', '1');
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /GATE_RED/);
  assert.equal(box.runs(), 1, 'submit ran the gate instead of trusting the stamp');
});

test('submit runs the gate even on a tree an earlier run passed, which a plain gate run may skip [V16, C3]', () => {
  const box = repoWithGate('true');
  assert.equal(box.run('gate').status, 0);
  assert.equal(box.runs(), 1);
  assert.match(box.run('gate').stdout, /this tree already passed/);
  assert.equal(box.runs(), 1, 'outside submit, the stamp still saves a run');
  const submitted = box.run('submit', '1');
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.match(submitted.stdout, /^submitted #1 at [0-9a-f]{12}; item check green; full gate: /mu);
  assert.equal(box.runs(), 2, 'submit ran the gate itself, stamp or no stamp');
});

test('submit refuses a tree its gate left changed: a new commit, or an edited tracked file [V16]', () => {
  for (const [moves, gate] of [
    ['a commit made during the gate', 'git commit -q --allow-empty -m "chore: moved under the gate"'],
    ['a tracked file edited during the gate', 'echo more >> SPEC.md'],
  ]) {
    const box = repoWithGate(gate);
    const head = box.git('rev-parse', 'HEAD');
    const refused = box.run('submit', '1');
    assert.equal(refused.status, 1, `${moves}: ${refused.stdout}`);
    assert.match(refused.stderr, /MOVED_DURING_GATE/, moves);
    assert.ok(refused.stderr.includes(head.slice(0, 12)), `${moves}: the refusal names the commit the gate was meant to check`);
    assert.equal(box.runs(), 1, moves);
  }
});


/** Quote a test executable or path as one shell word. */
function shellWord(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

/** Run the production private-check worker with a real shell and durable output file. */
function privateCheck(box, command) {
  const logPath = join(box.dir, 'private-command.log');
  const pidFile = logPath + '.pid';
  const run = runFixtureChild(process.execPath, [PRIVATE_WORKER], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
    input: JSON.stringify({ command, timeout: 30_000, pidFile, logPath }),
  });
  rmSync(pidFile, { force: true });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  return JSON.parse(run.stdout);
}

test('a piped gate fails on any red stage without changing its existing shell [V16,C7]', () => {
  const supported = runFixtureChild('set -o pipefail', { shell: true }).status === 0;
  const failing = repoWithGate('sh -c "exit 7" | tail -1');
  const red = failing.run('gate', '--json');
  assert.equal(red.status, 1, 'a failing producer cannot leave the gate green');
  if (supported) assert.equal(JSON.parse(red.stdout).green, false);
  else {
    const error = JSON.parse(red.stdout).error;
    assert.equal(error.code, 'PIPEFAIL_UNAVAILABLE');
    assert.match(error.message, /rewrite the gate without a pipe/u);
    assert.equal(failing.runs(), 0, 'an unsupported gate never starts');
  }
  const plain = repoWithGate('sh -c "exit 7"');
  assert.equal(plain.run('gate').status, 1, 'plain failure remains red');
  const passing = repoWithGate("printf 'pipeline-ok\\n' | grep -q pipeline-ok");
  const green = passing.run('gate', '--json');
  if (supported) assert.equal(green.status, 0, `${green.stdout}${green.stderr}`);
  else assert.equal(JSON.parse(green.stdout).error.code, 'PIPEFAIL_UNAVAILABLE');
  const ordinary = repoWithGate('true');
  assert.equal(ordinary.run('gate').status, 0, 'a plain passing gate needs no pipefail capability');
});

test('a piped gate fails safely while named-test item checks keep last-stage semantics [V16,C7]', () => {
  const box = repoWithGate('true');
  const fixture = join(box.dir, 'named-output.test.js');
  writeFileSync(fixture, `import {test} from 'node:test';
import {setTimeout} from 'node:timers/promises';
test('passing named item check', () => {});
test('output after the match', async () => {
  await setTimeout(25);
  process.stdout.write('x'.repeat(1024 * 1024));
});
`);
  const runner = resolve(import.meta.dirname, '../bin/run-tests.js');
  const named = `${shellWord(process.execPath)} ${shellWord(runner)} ${shellWord(fixture)} 2>&1`;
  const captured = (probe, assertion = `printf '%s\\n' "$out"`) => `out=$(${probe}) && ${assertion}`;
  const commands = [
    // On a miss the run's own output is printed unpiped, so a red baseline records why it was red and the
    // check's masked-exit rule still passes it (#2463).
    `${captured(named, `printf '%s\\n' "$out" | grep -Eq '^ok [0-9]+ - passing named item check'`)} || { printf '%s\\n' "$out"; exit 1; }`,
    captured('yes | grep -q y'),
    captured('sh -c "exit 7" | tail -1'),
  ];
  for (const command of commands) {
    const item = repoWithGate('true', command);
    const baseline = JSON.parse(item.run('show', '1', '--json').stdout).item_check_baseline;
    assert.equal(baseline.result, 'green', `background baselines preserve last-stage semantics: ${JSON.stringify({ command, reason: baseline.reason })}`);
    const checked = item.run('check', '1', '--yes');
    assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
    const submitted = item.run('submit', '1', '--json');
    assert.equal(submitted.status, 0, `${submitted.stdout}${submitted.stderr}`);
    assert.equal(JSON.parse(submitted.stdout).gate.check.green, true, 'submission uses the same check semantics');
    const verified = privateCheck(item, command);
    assert.equal(verified.status, 0, JSON.stringify(verified));
    assert.equal(verified.error, null, 'the private verifier keeps its original shell behavior');
  }
});

const FLAKY = { file: 'test/flaky.test.js', name: 'flaky target' };
const FLAKY_GATE = 'node --test --test-reporter=tap test/flaky.test.js';

/**
 * A real repo whose accepted gate runs one real test that reads a marker outside the tree: present, it fails; absent,
 * it passes. So one committed tree really goes red and green, the way a load-dependent test does, with nothing faked.
 * The board is the repo's own, in its git directory, and the gate runs through the real `pullboard gate`.
 */
function flakeRepo(t, policy = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-quarantine-')));
  dirs.push(dir);
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'test'), { recursive: true });
  const saved = { ...process.env };
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); });
  for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
  delete process.env.PULLBOARD_RELAY_TOKEN;
  // The fixture gate is its own `node --test` run, not a child of this one.
  delete process.env.NODE_TEST_CONTEXT;
  Object.assign(process.env, { PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Flake Test', GIT_AUTHOR_EMAIL: 'flake@example.test', GIT_COMMITTER_NAME: 'Flake Test', GIT_COMMITTER_EMAIL: 'flake@example.test' });
  const git = (...args) => runFixtureGit(args, { cwd: root });
  git('init', '-q', '-b', 'main');
  const marker = join(root, '.git', 'flaky-red');
  const commit = (comment, extra = {}) => {
    writeFileSync(join(root, 'pullboard.json'), `${JSON.stringify({ gate: FLAKY_GATE, lanes: { app: { owns: ['test/'] } }, ...policy, ...extra }, null, 2)}\n`);
    writeFileSync(join(root, FLAKY.file), `import { existsSync } from 'node:fs';\nimport { test } from 'node:test';\n// ${comment}\n`
      + `test('flaky target', () => { if (existsSync(${JSON.stringify(marker)})) throw new Error('red this time'); });\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `test: ${comment}`);
    return git('rev-parse', 'HEAD^{tree}');
  };
  /**
   * Run the real gate once through the CLI, red when asked, and return what it printed. A plain gate skips a tree it
   * already passed; the landing gate never does, so the fixture clears that stamp to run the same tree again.
   */
  const gate = async (red, { landing = false, code = red ? 1 : 0 } = {}) => {
    if (red) writeFileSync(marker, 'red\n'); else rmSync(marker, { force: true });
    rmSync(join(root, '.git', 'pullboard-gate-green'), { force: true });
    let output = '';
    const io = { stdout: { isTTY: false, write: (text) => { output += text; } }, stderr: { write: (text) => { output += text; } } };
    assert.equal(await cli(landing ? ['gate', '--landing'] : ['gate'], { cwd: root, ...io }), code, output);
    return output;
  };
  const file = join(root, '.git', 'pullboard', 'board.sqlite');
  /** Open the repo's board the way a landing reads it: quarantine comes from accepted main's pullboard.json. */
  const open = () => {
    const board = openBoard(file);
    board.quarantineEnabled = () => mainPolicy(root).config.flakes?.quarantine === true;
    t.after(() => store.closeBoard(board));
    return board;
  };
  const receipts = join(root, '.git', 'pullboard', 'gate-receipts');
  mkdirSync(dirname(file), { recursive: true });
  const setup = openBoard(file);
  store.ensureCoordinator(setup, root);
  store.closeBoard(setup);
  return { root, git, commit, gate, open, receipts, marker };
}

test('the same tree red and green proves a flake and files it once [C7,D1]', async (t) => {
  const box = flakeRepo(t);
  const tree = box.commit('one');
  await box.gate(true);
  let board = box.open();
  const [red] = nativeGateRuns(board);
  assert.equal(red.tree, tree, 'every run records the tree it ran on');
  assert.equal(red.green, false);
  assert.deepEqual(red.failures, [FLAKY], 'a red run names the committed test that failed');
  assert.ok(red.load.cpus >= 1 && red.load.average.length === 3 && red.load.freeMB >= 0, 'every run records the host load');
  assert.equal(red.by, 'coordinator', 'the main checkout records as the coordinator');
  assert.equal(store.listItems(board, { all: true }).length, 0, 'a red run alone proves nothing');
  await box.gate(false);
  board = box.open();
  const items = store.listItems(board, { all: true });
  assert.equal(items.length, 1, 'the same tree red and green files one item');
  assert.match(items[0].item_title, /^Flaky test: test\/flaky\.test\.js :: flaky target/u);
  const [, green] = nativeGateRuns(board);
  assert.equal(green.green, true);
  assert.match(items[0].item_brief, new RegExp(red.id, 'u'), 'the red run is the evidence on the item');
  assert.match(items[0].item_brief, new RegExp(green.id, 'u'), 'and so is the green run');
  assert.match(items[0].item_brief, /"load":\{"average":/u, 'with the host load of each');
  assert.equal(nativeFlakeQuarantines(board).length, 1);
  await box.gate(true);
  await box.gate(false);
  board = box.open();
  assert.equal(nativeGateRuns(board).length, 4, 'every run is recorded');
  assert.equal(store.listItems(board, { all: true }).length, 1, 'more red and green runs of the same test file no second item');
  box.commit('two');
  await box.gate(false);
  board = box.open();
  assert.equal(store.listItems(board, { all: true }).length, 1, 'a green run of another tree proves nothing new');
  assert.equal(waivedFailures(board, [FLAKY], landingPorts), null, 'with quarantine off by default, the proven flake still blocks a landing');
  assert.deepEqual(liveWaiverProjection(board, landingPorts), []);
});

test('a quarantined test reports but does not block [C7,D1]', async (t) => {
  const box = flakeRepo(t, { flakes: { quarantine: true } });
  box.commit('one');
  assert.equal(waivedFailures(box.open(), [FLAKY], landingPorts), null, 'a red test blocks before it is proven flaky');
  await box.gate(true);
  await box.gate(false);
  let board = box.open();
  const covered = waivedFailures(board, [FLAKY], landingPorts);
  assert.equal(covered?.length, 1, 'the proven flake no longer blocks');
  const [item] = store.listItems(board, { all: true });
  assert.equal(waiverLine(covered[0]), `quarantined: flaky target (test/flaky.test.js) is a proven flake, reported but not blocking until repair #${item.item_id} is verified`, 'it still reports by name');
  assert.deepEqual(liveWaiverProjection(board, landingPorts), [{ kind: 'name', test: 'flaky target' }], 'the landing run keeps going past it and still reports it');
  assert.equal(waivedFailures(board, [FLAKY, { file: 'test/other.test.js', name: 'another failure' }], landingPorts), null, 'a quarantine never hides a different red');
  assert.equal(waivedFailures(board, [{ file: 'test/other.test.js', name: FLAKY.name }], landingPorts), null, 'the same name in another file is not covered');
  // A proof this machine's gate did not run, such as one replayed from another machine, waives nothing here.
  renameSync(box.receipts, `${box.receipts}.elsewhere`);
  assert.equal(waivedFailures(board, [FLAKY], landingPorts), null, 'a quarantine waives only runs whose receipts are on the landing machine');
  renameSync(`${box.receipts}.elsewhere`, box.receipts);
  const landing = await box.gate(true, { landing: true, code: 0 });
  assert.match(landing, /^landing gate waived, not green: 1 failure\(s\)/mu, 'a landing run goes past the quarantined red without calling it green');
  assert.match(landing, /^quarantined: flaky target \(test\/flaky\.test\.js\) is a proven flake, reported but not blocking/mu, 'and still reports it');
  board = box.open();
  // The repair is built, submitted and verified by two different agents; only then does the test block again.
  const builder = store.register(board, { lane: 'app', path: join(box.root, '..', 'build'), route: 'strong' });
  const reviewer = store.register(board, { lane: 'app', path: join(box.root, '..', 'review'), route: 'strong' });
  store.claim(board, item.item_id, { agentId: builder, lane: 'app', leaseMs: 3600000, freeze: () => ({ text: 'repair', digest: 'd'.repeat(64) }) });
  submitFixture(board, item.item_id, { agentId: builder, commit: 'e'.repeat(40), tree: 'f'.repeat(40) });
  assert.equal(waivedFailures(board, [FLAKY], landingPorts)?.length, 1, 'a submitted repair does not lift the quarantine');
  store.verify(board, item.item_id, { agentId: reviewer, decision: 'ACCEPT', head: 'e'.repeat(40), digest: 'd'.repeat(64), policy: 'any', note: 'synthetic board-state fixture' });
  assert.equal(waivedFailures(board, [FLAKY], landingPorts), null, 'the verified repair makes the test block again');
  // It fails again after its fix landed: it blocks, and only a new red-and-green proof files a new item.
  box.commit('three');
  await box.gate(true);
  board = box.open();
  assert.equal(waivedFailures(board, [FLAKY], landingPorts), null, 'a failure after its fix blocks');
  assert.equal(store.listItems(board, { all: true }).length, 1);
  await box.gate(false);
  board = box.open();
  assert.equal(store.listItems(board, { all: true }).length, 2, 'a second proof after the fix files a new item');
  assert.equal(waivedFailures(board, [FLAKY], landingPorts)?.length, 1);
});

test('a hand-recorded run never quarantines a test [C7,D1]', async (t) => {
  const box = flakeRepo(t, { flakes: { quarantine: true } });
  const tree = box.commit('one');
  const head = box.git('rev-parse', 'HEAD');
  const board = box.open();
  const builder = store.register(board, { lane: 'app', path: join(box.root, '..', 'build'), route: 'strong' });
  const load = { average: [0, 0, 0], cpus: 1, freeMB: 100 };
  const forged = (id, green) => ({ version: 1, id, kind: 'land', tree, head, main: head, command: 'c'.repeat(64), green,
    failures: green ? [] : [FLAKY], load, at: new Date().toISOString() });
  const runs = [forged('00000000-0000-4000-8000-000000000001', false), forged('00000000-0000-4000-8000-000000000002', true)];
  for (const receipt of runs) {
    for (const agentId of ['coordinator', builder]) {
      assert.throws(() => nativeRecordGateRun(board, { agentId, receipt, lane: 'app' }), (error) => error.code === 'GATE_RUN_UNBOUND' || assert.fail(error), 'a run recorded by hand is refused');
      assert.throws(() => prepareEngineMove(board, 'recordGateRun', [{ agentId, receipt, lane: 'app' }], { id: `move-${receipt.id.slice(-1)}-${agentId}`, actor: agentId }),
        (error) => error.code === 'GATE_RUN_UNBOUND', 'and so is sealing it as a move');
    }
  }
  // A seat that seals its made-up runs by hand, past prepareEngineMove, is replayed as a record but proves nothing.
  for (const [sequence, receipt] of runs.entries()) {
    const move = { version: 1, engine: ENGINE_VERSION, id: `forged-${sequence}`, operation: 'recordGateRun', args: [{ agentId: builder, receipt, lane: 'app' }], actor: builder };
    applyEngineMove(board, move, { sequence: sequence + 1, at: new Date().toISOString() });
  }
  assert.equal(store.listItems(board, { all: true }).length, 0, 'no item is filed from runs a seat recorded by hand');
  assert.deepEqual(nativeFlakeQuarantines(board), []);
  // Running something other than the accepted gate is a real execution, but of the wrong command: it leaves no receipt.
  const fake = `printf 'TAP version 13\\nnot ok 1 - flaky target\\n  ---\\n  location: ${join(box.root, FLAKY.file)}:4:1\\n  ...\\n1..1\\n'; exit 1`;
  const observed = [];
  const observer = Object.assign(async () => {}, { recordRun: async (id) => observed.push(id) });
  for (const _ of [1, 2]) await runGate(box.root, { ...mainPolicy(box.root).config, gate: fake }, { executionServices, trustStamp: false, onFailure: observer });
  assert.deepEqual(observed, [], 'a command other than the accepted gate leaves no receipt to record');
  assert.equal(existsSync(box.receipts), false, 'and nothing in the receipt store');
  // A real receipt cannot be reused to say something else: each altered field breaks the binding.
  await box.gate(true);
  const reopened = box.open();
  const [real] = nativeGateRuns(reopened);
  const { eventId, by, ...receipt } = real;
  for (const lie of [{ ...receipt, green: true, failures: [] }, { ...receipt, failures: [{ file: FLAKY.file, name: 'another test' }] }, { ...receipt, command: 'c'.repeat(64) },
    { ...receipt, id: '00000000-0000-4000-8000-000000000003' }]) {
    assert.throws(() => nativeRecordGateRun(reopened, { agentId: 'coordinator', receipt: lie, lane: 'app' }), (error) => ['GATE_RUN_UNBOUND', 'GATE_RUN_CHANGED'].includes(error.code));
  }
  assert.equal(store.listItems(reopened, { all: true }).length, 0, 'one real red and no green proves nothing');
  assert.equal(waivedFailures(reopened, [FLAKY], landingPorts), null, 'no landing block is removed');
});

/** A web project whose one source file is imported by thirty test files, each recording its own run. */
function largeSelectionProject(deferAbove, { inline = false } = {}) {
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  // Landing diagnostics require TAP completion evidence on both Node 22 and Node 24.
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, submitGate: 'landing', affectedTests: 'node --test --test-reporter=tap',
    submitInvariants: ['web/guard.test.js'], ...(inline ? { gate: 'node --test --test-reporter=tap web/gate-check.test.js' } : { landing: { perItem: false, manualOverride: true, publish: 'separate' } }), ...(deferAbove ? { submitDeferAbove: deferAbove } : {}) }, null, 2));
  if (inline) {
    // An inline landing pushes its gated tip, so it needs a remote; its gate only checks for a red marker file.
    box.git(box.dir, 'init', '-q', '--bare', join(box.dir, 'origin.git'));
    box.git(box.repo, 'remote', 'add', 'origin', join(box.dir, 'origin.git'));
  }
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/core.js'), 'export const value = 1;\n');
  writeFileSync(join(box.repo, 'web/fix.js'), 'export const fixed = false;\n');
  const record = () => `import { appendFileSync } from 'node:fs';\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\n`;
  writeFileSync(join(box.repo, 'web/gate-check.test.js'), `${record()}import { existsSync } from 'node:fs';\n`
    + `test('no red marker [G1]', () => assert.equal(existsSync(new URL('./RED', import.meta.url)), false));\n`);
  writeFileSync(join(box.repo, 'web/guard.test.js'), `${record()}test('guard [G1]', () => { appendFileSync(process.env.DEFER_MARKER, 'guard\\n'); });\n`);
  for (let index = 0; index < 30; index += 1) {
    writeFileSync(join(box.repo, `web/selected-${String(index).padStart(2, '0')}.test.js`), `${record()}import { value } from './core.js';\nimport { fixed } from './fix.js';\n`
      + `test('selected ${index} [G1]', () => { appendFileSync(process.env.DEFER_MARKER, '${index}\\n'); assert.notEqual(value, 'red'); assert.ok(value !== 'needs-fix' || fixed); });\n`);
  }
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: thirty tests import one source');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.env.DEFER_MARKER = join(box.dir, 'ran.log');
  delete box.env.NODE_TEST_CONTEXT;
  const ran = () => existsSync(box.env.DEFER_MARKER) ? readFileSync(box.env.DEFER_MARKER, 'utf8').trim().split('\n').filter(Boolean) : [];
  /** Add, claim, change the shared source and submit one item, returning its receipt and what ran. */
  const submitChange = (value, { cwd = box.web, files = [] } = {}) => {
    const added = fixtureAdd(box.run, box.repo, 'web', `Set the value to ${value}`, '--specs', 'G1', '--criterion', 'The source exists.', '--check', 'test -f web/core.js', '--wait', '--json');
    assert.equal(added.code, 0, added.err);
    const id = JSON.parse(added.out).item.item_id;
    const claimed = box.run(cwd, 'claim', String(id));
    assert.equal(claimed.code, 0, `claim: ${claimed.err}${claimed.out}`);
    for (const [path, text] of files) writeFileSync(join(cwd, path), text);
    assert.equal(e2e.commitFile(box, cwd, files.length ? files[0][0] : 'web/core.js', files.length ? files[0][1] : `export const value = ${JSON.stringify(value)};\n`, `feat(web): set the value [G1]`).status, 0, 'the item change commits');
    rmSync(box.env.DEFER_MARKER, { force: true });
    const submitted = box.run(cwd, 'submit', String(id), '--json');
    assert.equal(submitted.code, 0, submitted.err + submitted.out);
    const receipt = JSON.parse(submitted.out);
    const proof = onLocalBoard(box, board => JSON.parse(store.events(board, { itemId: id }).findLast(row => row.event_kind === 'submit').event_detail));
    return { id, receipt, proof, ran: ran() };
  };
  /** Accept one submitted item as the coordinator, at its exact commit. */
  const accept = (id, commit) => {
    box.git(box.repo, 'switch', '-q', '--detach', commit);
    try {
      const verified = box.run(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'The source exists.');
      assert.equal(verified.code, 0, `verify: ${verified.err}${verified.out}`);
    }
    finally { box.git(box.repo, 'switch', '-q', 'main'); }
  };
  return { box, ran, submitChange, accept };
}

/** Read a fixture's real board through its public interface. */
function onLocalBoard(box, action) {
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { return action(board); } finally { store.closeBoard(board); }
}

test('a large affected selection is deferred to landing at submit [C7]', () => {
  const selected = Array.from({ length: 30 }, (_, index) => `web/selected-${String(index).padStart(2, '0')}.test.js`);
  const all = [...Array.from({ length: 30 }, (_, index) => String(index)), 'guard'].sort();
  const on = largeSelectionProject(20);
  const green = on.submitChange(2);
  assert.equal(green.receipt.gate.full, false);
  assert.equal(green.receipt.gate.deferred, true);
  assert.deepEqual(green.ran, ['guard'], 'submit ran the frozen check, static checks and the invariant file only');
  assert.deepEqual(green.proof.submissionProof.files, ['web/guard.test.js'], 'the receipt names what actually ran');
  assert.deepEqual(green.proof.submissionProof.deferredFiles, selected, 'the submission records the thirty deferred files');
  assert.match(green.proof.note, /30 affected test files deferred to the landing gate/u, 'reviewers see the deferral');
  assert.match(green.receipt.gate.report, /30 affected test files deferred to the landing gate/u);
  on.accept(green.id, green.receipt.commit);
  rmSync(on.box.env.DEFER_MARKER, { force: true });
  const landed = on.box.run(on.box.repo, 'land', '--json');
  assert.equal(landed.code, 0, landed.err + landed.out);
  assert.deepEqual(JSON.parse(landed.out).landed, [green.id]);
  assert.deepEqual(on.ran().sort(), all, 'landing ran every deferred file before the item landed');

  const red = on.submitChange('red');
  assert.deepEqual(red.ran, ['guard'], 'a red deferred file is not run at submit');
  on.accept(red.id, red.receipt.commit);
  const blocked = on.box.run(on.box.repo, 'land', '--json');
  assert.equal(blocked.code, 0, blocked.err + blocked.out);
  assert.deepEqual(JSON.parse(blocked.out).landed, [], 'a red deferred selection lands nothing');
  const reopened = JSON.parse(on.box.run(on.box.repo, 'show', String(red.id), '--json').out);
  assert.notEqual(reopened.item_status, 'verified', 'the red item is sent back like a red submit');
  assert.equal(reopened.item_merged_commit, null);
  assert.ok(reopened.thread.some(entry => entry.kind === 'reopen' && /web\/selected-00\.test\.js/u.test(entry.detail.note)), 'the reopen names the failing deferred file');

  const inline = largeSelectionProject(20, { inline: true });
  const inlineRed = inline.submitChange('red');
  assert.deepEqual(inlineRed.ran, ['guard']);
  inline.accept(inlineRed.id, inlineRed.receipt.commit);
  const inlineLanding = inline.box.run(inline.box.repo, 'land', '--json');
  assert.equal(inlineLanding.code, 0, inlineLanding.err + inlineLanding.out);
  assert.deepEqual(JSON.parse(inlineLanding.out).landed, [], 'an inline landing whose gate passes anything still runs the deferred files and lands nothing on red');
  const inlineItem = JSON.parse(inline.box.run(inline.box.repo, 'show', String(inlineRed.id), '--json').out);
  assert.notEqual(inlineItem.item_status, 'verified', 'the inline red item is sent back');
  assert.equal(inlineItem.item_merged_commit, null);
  assert.ok(inline.ran().length > 1, 'the inline landing ran the deferred files');

  // Item A carries the fix B's deferred files need, and also turns the gate red; bisect removes A and rebuilds B alone.
  const split = largeSelectionProject(20, { inline: true });
  const second = join(split.box.dir, 'web-2');
  split.box.git(split.box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  // The second seat joins on the strong route like web-1, so it may claim the strong-routed items both build.
  const secondJoin = joinFixtureSeat(split.box, second, 'web', { model: FIXTURE_MODEL });
  assert.equal(secondJoin.code, 0, `join: ${secondJoin.err}${secondJoin.out}`);
  const itemA = split.submitChange('a', { files: [['web/fix.js', 'export const fixed = true;\n'], ['web/RED', 'red\n']] });
  const itemB = split.submitChange('needs-fix', { cwd: second });
  split.accept(itemA.id, itemA.receipt.commit);
  split.accept(itemB.id, itemB.receipt.commit);
  const splitLanding = split.box.run(split.box.repo, 'land', '--json');
  assert.equal(splitLanding.code, 0, splitLanding.err + splitLanding.out);
  assert.deepEqual(JSON.parse(splitLanding.out).landed, [], 'B does not land on a rebuilt tree that lost A\'s fix');
  for (const id of [itemA.id, itemB.id]) {
    const shown = JSON.parse(split.box.run(split.box.repo, 'show', String(id), '--json').out);
    assert.notEqual(shown.item_status, 'verified', `#${id} is sent back`);
    assert.equal(shown.item_merged_commit, null);
  }
  const reopenedB = JSON.parse(split.box.run(split.box.repo, 'show', String(itemB.id), '--json').out);
  assert.ok(reopenedB.thread.some(entry => entry.kind === 'reopen' && /web\/selected-\d\d\.test\.js/u.test(entry.detail.note)), 'B is sent back for its own deferred files');

  const off = largeSelectionProject(null).submitChange(2);
  assert.equal(off.proof.submissionProof.deferredFiles, undefined);
  assert.deepEqual(off.ran.sort(), all, 'with the setting off, submit runs all thirty as today');
});

/** Locate only durable logs belonging to this private fixture's actual native landing batches. */
function deferredLandingLogs(box) {
  const directory = join(box.repo, '.git', 'pullboard', 'landings');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true }).filter(path => path.endsWith('.log'))
    .map(path => ({ path: join(directory, path), text: readFileSync(join(directory, path), 'utf8') }));
}

test('a red deferred landing keeps its real failing file and durable log [C7]', () => {
  const project = largeSelectionProject(20, { inline: true });
  const red = project.submitChange('red');
  project.accept(red.id, red.receipt.commit);
  const result = project.box.run(project.box.repo, 'land', '--json');
  assert.equal(result.code, 0, result.err + result.out);
  const shown = JSON.parse(project.box.run(project.box.repo, 'show', String(red.id), '--json').out);
  assert.ok(shown.thread.some(entry => entry.kind === 'reopen' && /web\/selected-00\.test\.js/u.test(entry.detail.note)), 'the refusal retains the actual failing file');
  const logs = deferredLandingLogs(project.box);
  assert.ok(logs.some(log => /selected 0 \[G1\]/u.test(log.text) && /not ok/u.test(log.text)), 'a durable native landing log retains the actual failing test output');
});

test('a pre-test native policy refusal is not reported as deferred files red [C7]', () => {
  const project = largeSelectionProject(20, { inline: true });
  const missing = join(project.box.dir, 'uncommitted-policy');
  mkdirSync(missing);
  project.box.git(missing, 'init', '-q', '-b', 'main');
  const source = new URL('../packages/sandbox/src/shell/trusted-policy.js', import.meta.url).href;
  const launcher = `import { mainPolicy } from ${JSON.stringify(source)};\nimport { spawnSync } from 'node:child_process';\nconst files=process.argv.slice(2);\nif (!files.some(file=>file.includes('selected-'))) { const child=spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{stdio:'inherit'}); process.exitCode=child.status??1; } else { try { mainPolicy(${JSON.stringify(missing)}); throw new Error('missing policy unexpectedly accepted'); } catch (error) { if (!error.code) throw error; console.log(JSON.stringify({version:1,error:{code:error.code,message:error.message,next:'restore the committed coordinator policy'}},null,2)); process.exitCode=1; } }\n`;
  writeFileSync(join(project.box.repo, 'web/policy-launcher.mjs'), launcher);
  const policy = join(project.box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(policy, 'utf8'));
  writeFileSync(policy, JSON.stringify({ ...config, affectedTests: 'node web/policy-launcher.mjs' }, null, 2));
  project.box.git(project.box.repo, 'add', '-A');
  project.box.git(project.box.repo, 'commit', '-q', '-m', 'chore: exercise a native policy refusal before tests');
  project.box.git(project.box.web, 'merge', '-q', '--ff-only', 'main');
  const ready = project.submitChange(2);
  project.accept(ready.id, ready.receipt.commit);
  rmSync(project.box.env.DEFER_MARKER, { force: true });
  const result = project.box.run(project.box.repo, 'land', '--json');
  assert.equal(result.code, 1, result.err + result.out);
  assert.equal(JSON.parse(result.out).error.code, 'NO_POLICY', 'the exact native refusal survives without a test-red wrapper');
  assert.doesNotMatch(result.out + result.err, /\d+ file\(s\) red|the deferred affected tests are red/u);
  assert.deepEqual(project.ran(), [], 'no selected test or invariant executes after the pre-test policy refusal');
  assert.ok(deferredLandingLogs(project.box).some(log => /NO_POLICY/u.test(log.text)), 'the refusal output is retained for diagnosis');
});
