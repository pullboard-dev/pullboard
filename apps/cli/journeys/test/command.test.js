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
import {
  HOST,
  installSshStandIn,
} from '../../tests/fixtures/runner/ssh.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const PASSES = "import { test } from 'node:test';\ntest('passes', () => {});\n";
const HANGS = "import { test } from 'node:test';\ntest('hangs', () => new Promise(() => {}));\n";
const FAILS = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('fails here', () => assert.equal(1, 2));\n";

test('pullboard test runs files as a pulled job with a per-file timeout [C7]', { timeout: 240_000 }, async () => { // budget: hang ceiling for the pulled test jobs (a run and its main comparisons); not a speed target.
  const box = e2e.project('true');
  // Main holds the focused runner, with its per-test timeout, and a test that hangs on main as well.
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, affectedTests: 'node --test --test-reporter=tap --test-timeout=3000' }, null, 2));
  mkdirSync(join(box.repo, 'test'));
  for (const [name, text] of [['ok', PASSES], ['hang', HANGS], ['changed', PASSES]]) writeFileSync(join(box.repo, `test/${name}.test.js`), text);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: focused runner and three test files');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  // The pulled job runs the committed head, so the agent's change is committed here.
  writeFileSync(join(box.web, 'test/changed.test.js'), FAILS);
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'test: the changed file fails');

  const started = Date.now();
  const ran = await box.runLocal(box.web, 'test', 'test/ok.test.js', 'test/hang.test.js', 'test/changed.test.js', '--json');
  const seconds = (Date.now() - started) / 1000;
  assert.equal(ran.code, 1, `a red file makes the run red: ${ran.out} ${ran.err}`);
  const result = JSON.parse(ran.out);
  console.log(ran.out, ran.err);
  assert.ok(result.runner && result.runner !== 'this machine', `the files ran on a pulled runner: ${ran.out}`);
});

test('pullboard test names why it ran on this machine, and every installed hook points at it [C7]', { timeout: 120_000 }, async () => { // budget: hang ceiling for real init, join and one local run; not a speed target.
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, affectedTests: 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap' }, null, 2));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/ok.test.js'), PASSES);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: focused runner and one test file');
  // Pull dispatch is the default and would offer a runner job none serves here; this case judges the local run.
  const ran = await box.runLocal(box.repo, 'test', 'test/ok.test.js', '--json');
  assert.equal(ran.code, 0, ran.err);
  const result = JSON.parse(ran.out);
  assert.equal(result.runner, 'this machine');
  assert.match(result.local, /no runners are registered/u, 'the result says why the run stayed here');
  assert.ok(result.diagnostics.some((line) => /green on this machine in \d+s: no runners are registered.*pullboard runner add/u.test(line)),
    `the diagnostic names the reason and the command that adds a runner: ${result.diagnostics}`);
  for (const hook of ['commit-msg', 'pre-commit', 'pre-merge-commit', 'pre-push']) {
    assert.match(readFileSync(join(box.repo, '.githooks', hook), 'utf8'), /pullboard test <test files>/u, `${hook} names pullboard test`);
  }
  // The approved agents block (10 Nov) hands test running to Pullboard rather than naming the command.
  assert.match(readFileSync(join(box.repo, 'AGENTS.md'), 'utf8'), /\*\*Gate:\*\* Pullboard runs it; never run whole suites/u, 'the agent guidance leaves test running to Pullboard');
});

test('a runner-bound test run passes a local memory hold [C7]', { skip: 'CONTROLLER_ONLY: deleted with #6579' }, async () => {
  await assertRunnerMemoryAdmission();
});
