/** @pullboard-test-input packages/gate/src/io/run/tests.js apps/cli/src/io/run/tests.js */
/** A real test run names the test file by its full path from the repository root, never by a bare file name [C7,V32,V33,#9647,#4867]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellSandbox } from '../../../../store/tests/fixtures/cell.js';
import { runFocusedRunner } from '../../fixtures/focused-runner.js';

const FILE = 'packages/alpha/tests/gate.test.js';

test('gate.full-paths.run-names-file-by-full-path: clause 1: node packages/gate/src/io/run/tests.js on one passing file shows its output naming that file by its full path from the repo root, never a bare name [C7,V32,V33]', t => {
  const box = cellSandbox(t);
  const work = join(box.dir, 'work');
  box.git(box.dir, 'init', '-q', '-b', 'main', work);
  writeFileSync(join(work, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(work, 'packages/alpha/tests'), { recursive: true });
  writeFileSync(join(work, FILE), "import { test } from 'node:test'; test('works', () => {});\n");
  box.git(work, 'add', '-A');
  box.git(work, 'commit', '-q', '-m', 'fixture');
  const env = { ...box.env };
  delete env.PULLBOARD_TEST_STAGE;
  delete env.PULLBOARD_LANDING_RUN;
  delete env.PULLBOARD_TEST_PROGRESS;
  const result = runFocusedRunner(work, [FILE], env);
  const output = result.text;
  assert.equal(result.status, 0, output);
  assert.ok(output.includes(FILE), `the run names the file by its full path from the repo root: ${output}`);
  for (const line of output.split('\n').filter(text => text.includes('gate.test.js'))) {
    assert.ok(line.includes(FILE), `a line that names the file names its full path: ${line}`);
  }
});
