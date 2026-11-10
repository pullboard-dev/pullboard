/** @pullboard-test-input source-tree */
/** A bare run-tests call names no file and is refused outside the machine's own stages; the suite is the gate's job [C7,S10]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cellSandbox } from '../../../../../store/tests/fixtures/cell.js';
import { runFixtureChild } from '../../../../../../apps/cli/tests/fixtures/child.js';

const RUNNER = fileURLToPath(new URL('../../../../src/io/run/tests.js', import.meta.url));
const REFUSAL = '[TEST_SELECTION_EMPTY]';

/** A disposable repository with one passing test file, so a run that is admitted has something to run. */
function fixture(t) {
  const box = cellSandbox(t);
  const work = join(box.dir, 'work');
  box.git(box.dir, 'init', '-q', '-b', 'main', work);
  writeFileSync(join(work, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(work, 'one.test.js'), "import { test } from 'node:test'; test('one', () => {});\n");
  const env = { ...process.env, PULLBOARD_MODEL: 'Test Model' };
  delete env.PULLBOARD_TEST_STAGE;
  delete env.PULLBOARD_LANDING_RUN;
  return { work, env };
}

/** Run the real runner in the fixture with these arguments and environment additions. */
function run(box, args, extra = {}) {
  return runFixtureChild(process.execPath, [RUNNER, ...args], { cwd: box.work, env: { ...box.env, ...extra }, encoding: 'utf8', timeout: 120_000 });
}

test('a bare call from a seat is refused by name before any test runs [C7,S10]', t => {
  const box = fixture(t);
  const bare = run(box, []);
  assert.equal(bare.status, 1, bare.stdout + bare.stderr);
  assert.ok(bare.stderr.includes(REFUSAL) && bare.stderr.includes('--all'), bare.stderr);
  // Options alone name no file either: a name pattern without a file is still the whole suite.
  const pattern = run(box, ['--test-name-pattern=one']);
  assert.equal(pattern.status, 1, pattern.stdout + pattern.stderr);
  assert.ok(pattern.stderr.includes(REFUSAL), pattern.stderr);
});

test('a named file, --all by hand, and the machine stages are admitted past the selection check [C7,S10]', t => {
  const box = fixture(t);
  for (const [label, args, extra] of [
    ['a named file', ['one.test.js'], {}],
    ['--all', ['--all'], {}],
    ['the gate stage', [], { PULLBOARD_TEST_STAGE: 'gate' }],
    ['a landing run', [], { PULLBOARD_LANDING_RUN: '1' }],
  ]) {
    const result = run(box, args, extra);
    assert.ok(!result.stderr.includes(REFUSAL), `${label}: ${result.stderr}`);
    assert.ok(!(result.stderr + result.stdout).includes('--all'), `${label}: --all never reaches node --test`);
  }
});
