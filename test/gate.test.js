/**
 * The gate's digest (V10): what an agent reads of a red run. And submit's own run of the gate (V16):
 * no stamp stands in for it, and the tree must hold still while it runs.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { digestOf } from '../src/gate.js';

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
 */
function repoWithGate(gate) {
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
  };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: `echo run >> ../runs.log; ${gate}` }));
  writeFileSync(join(repo, 'SPEC.md'), '# Demo\n\n## G · Goals\n- G1 [approved, must] It works. | gate: test\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: a spec');
  assert.equal(run('add', 'coordinator', 'Work').status, 0);
  assert.equal(run('claim', '1').status, 0);
  const runs = () => {
    try {
      return readFileSync(join(dir, 'runs.log'), 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  return { repo, git, run, runs };
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

test('submit refuses a tree that moved while its gate ran: a new commit, or an edited tracked file [V16]', () => {
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
