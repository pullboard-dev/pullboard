/** @pullboard-test-input apps/cli/pullboard.js apps/runner/src/io/private/check/worker.js packages/gate/src/io/budgets.js packages/gate/src/io/run/tests.js packages/gate/tests/fixtures/budgets.js packages/git/index.js */
/**
 * The gate's digest (V10): what an agent reads of a red run. And submit's own run of the gate (V16):
 * no stamp stands in for it, and the tree must hold still while it runs.
 *
 * @pullboard-world-pin the clock-budget case copies the shipped scanner entry into its fixture.
 */
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { repoPath } from '../../../../packages/kernel/light.js';
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChild as spawnSync,
  runFixtureChild,
  runFixtureGit,
  startFixtureChild as spawn,
} from '../../tests/fixtures/child.js';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { pathToFileURL } from 'node:url';
import * as store from '../../../../packages/store/index.js';
import { main as cli } from '../../tests/fixtures/native.js';
import {
  digestOf,
  testConcurrency,
} from '../../../../packages/gate/index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { gateRepoFixture } from '../../tests/fixtures/gate/repo.js';
import {
  createE2eHelpers,
} from '../../tests/fixtures/e2e.js';
import {
  BROWSER_SLOT_HELD_ENV,
  GATE_SLOT_HELD_ENV,
  GATE_SLOT_POOL_ENV,
  GATE_SLOT_TOKEN_ENV,
} from '../../../../packages/resources/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const repoWithGate = gateRepoFixture(dirs);

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

/** Run a node child to completion without blocking this process, so independent cases overlap; same result shape as the sync runner. */
function runAsync(args, options) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (part) => { stdout += part; });
    child.stderr.on('data', (part) => { stderr += part; });
    child.once('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

test('the landing gate bounds its own concurrency [C7]', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-file-caps-')));
  dirs.push(root);
  copyPackageFiles(resolve(import.meta.dirname, '../../../..'), root);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  const config = join(root, 'pullboard.json');
  assert.deepEqual(testConcurrency(root, 7), { files: 7, browser: 2 }, 'the default file budget is the detected core budget');
  const selected = [];
  for (let id = 0; id < 9; id += 1) {
    const browser = id < 4;
    const folder = repoPath(root, browser ? 'test/cockpit' : 'test/ordinary');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `overlap-${id}.test.js`);
    selected.push(file);
    // A file takes a browser lease only by declaring it on its first line, not by its folder.
    writeFileSync(file, `${browser ? '// pullboard: browser\n' : ''}import {appendFileSync} from 'node:fs';
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
    // The cases write their own capture and machine home, so they run side by side; the setting file is fixed for the batch.
    await Promise.all(cases.map(async (example, caseIndex) => {
      const capture = join(root, `overlap-${setting.files}-${caseIndex}.jsonl`);
      const env = { ...process.env, PULLBOARD_CAP_CAPTURE: capture,
        PULLBOARD_MACHINE_HOME: join(root, `machine-${setting.files}-${caseIndex}`) };
      env.PULLBOARD_LANDING_RUN = example.landing ? '1' : '0';
      // process-level: the test runner is its own node entry and reads its own argv and env.
      const result = await runAsync([join(root, 'apps/cli/src/io/run/tests.js'), ...example.args, ...selected], { cwd: root, env });
      assert.equal(result.status, 0, `${example.name}: ${result.stdout}${result.stderr}`);
      const peak = fileOverlap(capture);
      assert.ok(peak.files <= setting.files, `${example.name}: file-body overlap ${peak.files} exceeds ${setting.files}`);
      assert.ok(peak.browser <= setting.browser, `${example.name}: browser-file overlap ${peak.browser} exceeds ${setting.browser}`);
      if (example.serial) assert.equal(peak.files, 1, 'false keeps the native runner serial');
      assert.deepEqual(peak.starts.sort((a, b) => a - b), Array.from({ length: 9 }, (_, id) => id),
        `${example.name}: every selected file runs once`);
      assert.match(result.stdout, /# tests 9\b/u);
      assert.match(result.stdout, /# fail 0\b/u);
    }));
  }
  writeFileSync(config, JSON.stringify({ testConcurrency: { files: 3, browser: 2 } }));
  const refusals = [];
  for (const value of ['4294967296', '9'.repeat(400)]) {
    const capture = join(root, `invalid-concurrency-${value.length}.jsonl`);
    // process-level: the test runner is its own node entry and reads its own argv and env.
    refusals.push(runAsync([join(root, 'apps/cli/src/io/run/tests.js'), `--test-concurrency=${value}`, ...selected], {
      cwd: root, env: { ...process.env, PULLBOARD_LANDING_RUN: '1', PULLBOARD_CAP_CAPTURE: capture,
        PULLBOARD_MACHINE_HOME: join(root, `machine-invalid-${value.length}`) },
    }).then((result) => {
      assert.notEqual(result.status, 0, 'an invalid native concurrency value is refused');
      assert.match(result.stderr, /invalid --test-concurrency value/u);
      assert.equal(existsSync(capture), false, 'invalid concurrency is refused before any file body runs');
    }));
  }
  let isolationCase = 0;
  for (const flag of ['--test-isolation', '--test_isolation', '--experimental-test-isolation',
    '--experimental_test_isolation', '--experimental_test-isolation', '--experimental-test_isolation']) {
    for (const args of [[`${flag}=none`], [flag, 'none']]) {
      const capture = join(root, `isolation-${isolationCase++}.jsonl`);
      // process-level: the test runner is its own node entry and reads its own argv and env.
      refusals.push(runAsync([join(root, 'apps/cli/src/io/run/tests.js'), ...args, selected.at(-1)], {
        cwd: root, env: { ...process.env, PULLBOARD_CAP_CAPTURE: capture,
          PULLBOARD_MACHINE_HOME: join(root, 'machine-isolation') },
      }).then((result) => {
        assert.notEqual(result.status, 0, `${args.join(' ')} must refuse non-isolated test files`);
        assert.match(result.stderr, /bounded browser test files require process isolation/u);
        assert.equal(existsSync(capture), false, 'a refused isolation mode never starts a test-file body');
      }));
    }
  }
  await Promise.all(refusals);
  writeFileSync(config, JSON.stringify({ testConcurrency: { browser: 3 } }));
  assert.throws(() => testConcurrency(root, 7), /browser must be 1 or 2/);
});

test('the gate stops before the suite on a missing clock-budget comment [C7]', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-gate-clock-budget-')));
  dirs.push(root);
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'test'));

  const actualPackage = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../package.json'), 'utf8'));
  const gateScript = actualPackage.scripts.gate;
  const fixturePackage = { ...actualPackage, scripts: { ...actualPackage.scripts, test: 'node test/suite-sentinel.js' } };
  assert.equal(fixturePackage.scripts.gate, gateScript, 'the real package gate command is preserved verbatim');
  writeFileSync(join(root, 'package.json'), JSON.stringify(fixturePackage, null, 2) + '\n');
  mkdirSync(join(root, 'packages/gate/tests/fixtures'), { recursive: true });
  copyFileSync(resolve(import.meta.dirname, '../../../../packages/gate/tests/fixtures/budgets.js'), join(root, 'packages/gate/tests/fixtures/budgets.js'));
  // The shipped scanner entry delegates to the gate package after the cells move.
  const scanner = join(root, 'packages/gate/src/shell');
  mkdirSync(scanner, { recursive: true });
  copyFileSync(resolve(import.meta.dirname, '../../../../packages/gate/src/io/budgets.js'), join(scanner, 'wall-clock-budgets.js'));
  writeFileSync(join(root, 'packages/gate/index.js'), "export { fixedWallMargins, wallClockViolations } from './src/shell/wall-clock-budgets.js';\n");
  // The scanner lists tracked files through the git package; the fixture supplies a plain git launcher for it.
  mkdirSync(join(root, 'packages/git'), { recursive: true });
  writeFileSync(join(root, 'packages/git/index.js'), "import { execFileSync } from 'node:child_process';\nexport const gitExecFileSync = (args, options) => execFileSync('git', args, options);\n");
  mkdirSync(join(root, 'apps/cli'), { recursive: true });
  writeFileSync(join(root, 'apps/cli/pullboard.js'), `if (process.argv.slice(2).join(' ') !== 'spec check') process.exit(2);
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

test('pullboard gate status refuses instead of running the gate [C7,P4]', async () => {
  const box = await repoWithGate('echo run >> ../runs.log');
  for (const name of [BROWSER_SLOT_HELD_ENV, GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV]) delete box.env[name];
  assert.equal((await box.runLocal('settings', 'gateSlots', '1')).status, 0, 'the fixture uses the holder pool\'s single gate slot');
  const resourceModule = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/resources/index.js')).href;
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
    // process-level: a held gate slot is process lifetime.
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
      // process-level: the command must queue behind a held slot and be killed.
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
      const gate = JSON.parse((await box.runLocal('resources', '--json')).stdout).resources.find(({ name }) => name === 'gate');
      assert.deepEqual(gate?.holders.map(({ agent }) => agent) ?? [], ['gate-argument-holder']);
      assert.equal(gate?.line.length ?? 0, 0, 'the refused command never becomes a gate waiter');
    }
    for (const words of [['status'], ['run'], ['unexpected', 'word']]) {
      const result = await box.runLocal('gate', ...words, '--json');
      assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
      const { error } = JSON.parse(result.stdout);
      assert.equal(error.code, 'GATE_ARGUMENT');
      assert.equal(error.next, 'use pullboard resources for status, or pullboard gate with no extra words to run the gate');
      assert.equal(box.runs(), 0, 'JSON refusal never starts the configured gate');
      const gate = JSON.parse((await box.runLocal('resources', '--json')).stdout).resources.find(({ name }) => name === 'gate');
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

test('gate before the first commit names the uncommitted config [I1,C7]', async () => {
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
  const run = (...args) => runCliInProcess(args, { cwd: repo, env });
  git('init', '-q', '-b', 'main');
  const initialized = await run('init', '--model', 'Test Coordinator');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  assert.equal(existsSync(join(repo, 'pullboard.json')), true, 'init wrote the coordinator config');

  const firstGate = await run('gate', '--json');
  assert.equal(firstGate.status, 1, 'the gate cannot read a policy before the initial commit');
  const firstRefusal = JSON.parse(firstGate.stdout).error;
  assert.equal(firstRefusal.code, 'NO_POLICY');
  assert.match(firstRefusal.message, /pullboard\.json is not committed/u);
  assert.match(firstRefusal.message, /git add pullboard\.json/u, 'the refusal gives the concrete staging command');

  const committed = await repoWithGate('true');
  committed.primaryGit('switch', '--detach', 'HEAD');
  const missingCoordinator = await committed.runLocal('gate', '--json');
  assert.equal(missingCoordinator.status, 1);
  const missingRefusal = JSON.parse(missingCoordinator.stdout).error;
  assert.equal(missingRefusal.code, 'NO_POLICY');
  assert.match(missingRefusal.message, /coordinator checkout is detached for review/u,
    'other genuine NO_POLICY failures keep their specific message');
});

test('gate after init in an existing repo says to commit the init files [I1,C7]', async () => {
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
  const run = (...args) => runCliInProcess(args, { cwd: repo, env });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Existing repository\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'chore: create existing repository');
  assert.equal((await run('init', '--model', 'Test Coordinator')).status, 0);

  const refused = await run('gate', '--json');
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
  // process-level: git runs the installed hooks, which call the CLI.
  const applied = runFixtureChild('/bin/sh', ['-c', fix], { cwd: repo, env: { ...env, PATH: `${shims}:${env.PATH ?? ''}` }, encoding: 'utf8' });
  assert.equal(applied.status, 0, `${applied.stdout}${applied.stderr}`);
  const afterFix = await run('gate', '--json');
  assert.notEqual(afterFix.stdout ? JSON.parse(afterFix.stdout).error?.code : undefined, 'NO_POLICY', 'the printed commit lets the gate read its policy');

  // A policy missing for any other reason keeps its own refusal.
  git('switch', '-q', '--detach', 'HEAD');
  const detached = await run('gate', '--json');
  assert.equal(detached.status, 1);
  const otherMissing = JSON.parse(detached.stdout).error;
  assert.equal(otherMissing.code, 'NO_POLICY');
  assert.doesNotMatch(otherMissing.message, /uncommitted/u, 'a committed config never gets the commit-your-setup message');

  // Git metadata kept outside the project (git init --separate-git-dir) gets the same advice.
  const separate = join(dir, 'separate');
  mkdirSync(separate);
  const separateGit = (...args) => runFixtureGit(args, { cwd: separate, env });
  const separateRun = (...args) => runCliInProcess(args, { cwd: separate, env });
  separateGit('init', '-q', '-b', 'main', '--separate-git-dir', join(dir, 'separate-metadata'));
  writeFileSync(join(separate, 'README.md'), '# Existing repository\n');
  separateGit('add', 'README.md');
  separateGit('commit', '-q', '-m', 'chore: create existing repository');
  assert.equal((await separateRun('init', '--model', 'Test Coordinator')).status, 0);
  const separateRefused = await separateRun('gate', '--json');
  assert.equal(separateRefused.status, 1);
  const separateRefusal = JSON.parse(separateRefused.stdout).error;
  assert.equal(separateRefusal.code, 'NO_POLICY');
  assert.match(separateRefusal.message, /pullboard\.json and Pullboard's initialized setup files are uncommitted/u,
    'a separate Git directory still gets the commit-your-setup message');
  assert.ok(separateRefusal.message.includes('SPEC.md') && !separateRefusal.message.includes('README.md'), separateRefusal.message);
});

test('a digest keeps the failures and the end within its cap, however long one line is [V10]', async () => {
  const digest = digestOf(`not ok 1 - ${'x'.repeat(3500)}\n${'ok\n'.repeat(50)}# fail 1\nsummary: 1 failed`);
  assert.ok(digest.length <= 3000, `${digest.length} characters`);
  assert.match(digest, /^not ok 1 - x+…\n/);
  assert.match(digest, /# fail 1\nsummary: 1 failed$/);
});

test('a digest of many failures stays within its cap and still ends with the summary [V10]', async () => {
  const failures = Array.from({ length: 200 }, (_, n) => `not ok ${n} - ${'y'.repeat(250)}`).join('\n');
  const digest = digestOf(`${failures}\n# tests 200\n# fail 200`);
  assert.ok(digest.length <= 3000, `${digest.length} characters`);
  assert.match(digest, /^not ok 0 - /);
  assert.match(digest, /# tests 200\n# fail 200$/);
});

test('a digest keeps the lines that say why a test failed, and skips passing tests however named [V10]', async () => {
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
