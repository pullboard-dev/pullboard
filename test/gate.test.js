/**
 * The gate's digest (V10): what an agent reads of a red run. And submit's own run of the gate (V16):
 * no stamp stands in for it, and the tree must hold still while it runs.
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, runFixtureChild as spawnSync, runFixtureChild, runFixtureGit } from './fixture-child.js';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { digestOf } from '../src/gate.js';

const PRIVATE_WORKER = resolve(import.meta.dirname, '../src/private-check-worker.js');

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

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
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: `echo run >> ../runs.log; ${gate}` }));
  writeFileSync(join(repo, 'SPEC.md'), '# Demo\n\n## G · Goals\n- G1 [approved, must] It works. | gate: test\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: a spec');
  const added = run('add', 'coordinator', 'Work', ...(check ? ['--check', check, '--wait'] : []));
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  assert.equal(run('claim', '1').status, 0);
  const runs = () => {
    try {
      return readFileSync(join(dir, 'runs.log'), 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  return { dir, repo, env, git, run, runs };
}

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
  writeFileSync(join(box.repo, box.git('rev-parse', '--git-path', 'pullboard-gate-green')), `${box.git('rev-parse', 'HEAD^{tree}')}\n`);
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
  assert.match(submitted.stdout, /gate green in \d+s/);
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
  const named = `${shellWord(process.execPath)} ${shellWord(runner)} ${shellWord(fixture)} 2>&1 | grep -Eq '^ok [0-9]+ - passing named item check'`;
  for (const command of [named, 'yes | grep -q y', 'sh -c "exit 7" | tail -1']) {
    const item = repoWithGate('true', command);
    const baseline = JSON.parse(item.run('show', '1', '--json').stdout).item_check_baseline;
    assert.equal(baseline.result, 'green', 'background baselines preserve last-stage semantics');
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
