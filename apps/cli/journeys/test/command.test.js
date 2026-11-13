/** @pullboard-test-loads packages/gate/index.js */
/** @pullboard-test-loads apps/cli/src/io/commands/status.js */
/** pullboard test runs named test files on the runner pool, and names a failure main already has [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { assertRunnerMemoryAdmission } from '../../tests/fixtures/runner/memory.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const PASSES = "import { test } from 'node:test';\ntest('passes', () => {});\n";
const HANGS = "import { test } from 'node:test';\ntest('hangs', () => new Promise(() => {}));\n";
const FAILS = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('fails here', () => assert.equal(1, 2));\n";

/** A project whose main holds the focused runner with its per-test timeout and a test that hangs on main as well; the agent's failing change is committed on its worktree, since a pulled job runs the committed head. */
function focusedProject() {
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, affectedTests: 'node --test --test-reporter=tap --test-timeout=3000' }, null, 2));
  mkdirSync(join(box.repo, 'test'));
  for (const [name, text] of [['ok', PASSES], ['hang', HANGS], ['changed', PASSES]]) writeFileSync(join(box.repo, `test/${name}.test.js`), text);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: focused runner and three test files');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  writeFileSync(join(box.web, 'test/changed.test.js'), FAILS);
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'test: the changed file fails');
  return box;
}

test('pullboard test runs files as a pulled job with a per-file timeout [C7]', { timeout: 240_000 }, async () => { // budget: hang ceiling for the pulled test job; not a speed target.
  const box = focusedProject();
  const started = Date.now();
  const ran = await box.runLocal(box.web, 'test', 'test/ok.test.js', 'test/hang.test.js', 'test/changed.test.js', '--json');
  const seconds = (Date.now() - started) / 1000;
  assert.equal(ran.code, 1, `a red file makes the run red: ${ran.out} ${ran.err}`);
  const result = JSON.parse(ran.out);
  // The pulled job's settled receipt names the runner that took it; the fixture's loopback runner is the only one alive.
  assert.match(result.runner, /^local-/u, `the files ran on the pulled local runner: ${ran.out}`);
  assert.deepEqual(result.counts, { passed: 1, failed: 1, skipped: 0 }, 'the receipt counts the passing file and the failing one');
  const output = readFileSync(result.logPath, 'utf8');
  assert.match(output, /^ok \d+ - .*passes/mu, 'the complete log keeps the TAP exactly as the runner printed it');
  assert.match(output, /fails here/u, 'the committed change ran on the runner');
  assert.match(output, /hangs/u, 'the hanging test stops at its timeout and is named');
  assert.ok(seconds < 200, `the hung file never holds the run past its timeout (${seconds}s)`); // budget: hang ceiling far above the 3 s test timeout; not a speed target.
});

test('pullboard test names a failure main already has, per file [C7]', async () => {
  const box = focusedProject();
  const ran = await box.runLocal(box.web, 'test', 'test/ok.test.js', 'test/hang.test.js', 'test/changed.test.js', '--json');
  const known = Object.fromEntries(JSON.parse(ran.out).known.map((entry) => [entry.file, entry.result]));
  assert.equal(known['test/hang.test.js'], 'red', 'the hang fails on main too, so it reads as a known main failure');
  assert.equal(known['test/changed.test.js'], 'green', 'the changed file passes on main, so its failure is new');
  assert.equal(known['test/ok.test.js'], undefined, 'a passing file needs no main comparison');
  const text = await box.runLocal(box.web, 'test', 'test/hang.test.js', '--compare-main');
  assert.equal(text.code, 1);
  assert.match(text.out.split('\n')[0], /file also fails on main at [a-f0-9]+: test\/hang\.test\.js \(case comparison unavailable\)/u, 'the first result line keeps the real file verdict without inventing a case match');
  assert.doesNotMatch(text.out, /not yours; accepted/u, 'a timeout is not an identical accepted case');
});

test('pullboard test names the local runner it ran on, and every installed hook points at it [C7]', { timeout: 120_000 }, async () => { // budget: hang ceiling for real init, join and one local run; not a speed target.
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, affectedTests: 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap' }, null, 2));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/ok.test.js'), PASSES);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: focused runner and one test file');
  // Pull dispatch is the default: the machine's own loopback runner takes the job and the settled receipt names it.
  const ran = await box.runLocal(box.repo, 'test', 'test/ok.test.js', '--json');
  assert.equal(ran.code, 0, ran.err);
  const result = JSON.parse(ran.out);
  assert.match(result.runner, /^local-/u, 'the result names the local runner that took the pulled job');
  for (const hook of ['commit-msg', 'pre-commit', 'pre-merge-commit', 'pre-push']) {
    assert.match(readFileSync(join(box.repo, '.githooks', hook), 'utf8'), /pullboard test <test files>/u, `${hook} names pullboard test`);
  }
  // The approved agents block (10 Nov) hands test running to Pullboard rather than naming the command.
  assert.match(readFileSync(join(box.repo, 'AGENTS.md'), 'utf8'), /\*\*Gate:\*\* Pullboard runs it; never run whole suites/u, 'the agent guidance leaves test running to Pullboard');
});

test('a runner-bound test run passes a local memory hold [C7]', { skip: 'CONTROLLER_ONLY: deleted with #6579' }, async () => {
  await assertRunnerMemoryAdmission();
});
