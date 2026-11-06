/** @pullboard-test-loads apps/cli/src/shell/commands/test.js */
/** A one-file pullboard test is the builder's own run; main's comparison runs only when asked [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project whose one test file is red, committed so main has the same red file. */
function redProject() {
  const box = e2e.project('true');
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, affectedTests: 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap' }));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test', 'red.test.js'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('red case', () => assert.fail('deliberate'));\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: one red file');
  return box;
}

test('clause 1: pullboard test <one file> reports its red cases without re-running the file on main', { timeout: 120_000 }, () => { // budget: hang ceiling for one real local run.
  const box = redProject();
  const ran = box.run(box.repo, 'test', 'test/red.test.js', '--json');
  assert.equal(ran.code, 1);
  const result = JSON.parse(ran.out);
  assert.equal(result.main, null, 'no main comparison ran');
  assert.deepEqual(result.known, []);
  assert.match(result.mainSkipped, /--compare-main/u);
  assert.match(ran.err, /main comparison skipped/u);
});

test('clause 2: pullboard test <file> --compare-main still runs the main comparison and prints that it is waiting on it', { timeout: 180_000 }, () => { // budget: hang ceiling for one run plus its main comparison.
  const box = redProject();
  const ran = box.run(box.repo, 'test', 'test/red.test.js', '--compare-main', '--json');
  assert.equal(ran.code, 1);
  const result = JSON.parse(ran.out);
  assert.ok(result.main, 'main was compared');
  assert.equal(result.mainSkipped, undefined);
  assert.match(ran.err, /waiting on the main comparison/u);
});
