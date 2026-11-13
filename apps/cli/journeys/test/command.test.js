/** @pullboard-test-loads packages/gate/index.js */
/** @pullboard-test-loads apps/cli/src/io/commands/status.js */
/** pullboard test runs named test files on the runner pool [C7]. */
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
import { focusedProject as focused } from '../../tests/fixtures/test/focused.js';
import { PASSES } from '../../tests/fixtures/test/focused.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The focused-runner project, its failing change committed on the builder worktree. */
const focusedProject = () => focused(e2e);

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
