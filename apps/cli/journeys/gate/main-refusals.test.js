/** @pullboard-test-input apps/cli/pullboard.js packages/gate/src/io/budgets.js packages/gate/tests/fixtures/budgets.js packages/git/index.js packages/resources/index.js */
/**
 * The gate's refusal and setup journeys (C7, P4, I1): split from main.test.js so the census runs them beside it.
 *
 * @pullboard-world-pin the clock-budget case copies the shipped scanner entry into its fixture.
 */
import assert from 'node:assert/strict';
import {
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
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { pathToFileURL } from 'node:url';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { gateRepoFixture } from '../../tests/fixtures/gate/repo.js';
import {
  BROWSER_SLOT_HELD_ENV,
  GATE_SLOT_HELD_ENV,
  GATE_SLOT_POOL_ENV,
  GATE_SLOT_TOKEN_ENV,
} from '../../../../packages/resources/index.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const repoWithGate = gateRepoFixture(dirs);

test('cli.journeys-gate-main-refusals.the-gate-stops-before-the-suite: the gate stops before the suite on a missing clock-budget comment [C7]', () => {
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

test('cli.journeys-gate-main-refusals.pullboard-gate-status-refuses-instead-of: pullboard gate status refuses instead of running the gate [C7,P4]', async () => {
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

test('cli.journeys-gate-main-refusals.gate-before-the-first-commit-names: gate before the first commit names the uncommitted config [I1,C7]', async () => {
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

test('cli.journeys-gate-main-refusals.gate-after-init-in-an-existing: gate after init in an existing repo says to commit the init files [I1,C7]', async () => {
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
