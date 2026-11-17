/** @pullboard-test-input packages/gate/src/io/run/tests.js apps/cli/src/io/run/tests.js */
/** A real test run names the test file by its full path from the repository root, never by a bare file name [C7,V32,V33,#9647,#4867]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { cellSandbox } from '../../../../store/tests/fixtures/cell.js';
import { runFixtureChild } from '../../fixtures/child.js';

const RUNNER = resolve(import.meta.dirname, '../../../src/io/run/tests.js');
const FILE = 'packages/alpha/tests/gate.test.js';

test('gate.full-paths.run-names-file-by-full-path: clause 1: node packages/gate/src/io/run/tests.js on one passing file shows its output naming that file by its full path from the repo root, never a bare name [C7,V32,V33]', t => {
  const box = cellSandbox(t);
  const work = join(box.dir, 'work');
  box.git(box.dir, 'init', '-q', '-b', 'main', work);
  writeFileSync(join(work, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(work, 'packages/alpha/tests'), { recursive: true });
  writeFileSync(join(work, FILE), "import { test } from 'node:test'; test('works', () => {});\n");
  const progress = join(box.dir, 'progress.jsonl');
  const env = { ...box.env, PULLBOARD_TEST_PROGRESS: progress };
  delete env.PULLBOARD_TEST_STAGE;
  delete env.PULLBOARD_LANDING_RUN;
  const result = runFixtureChild(process.execPath, [RUNNER, FILE], { cwd: work, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const rows = readFileSync(progress, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.length > 0, 'the run reports its file');
  assert.deepEqual([...new Set(rows.map(row => row.file))], [FILE], 'every progress line names the full path');
  assert.ok(rows.some(row => row.state === 'green'), 'and the file ends green');
  for (const line of (result.stdout + result.stderr).split('\n').filter(text => text.includes('gate.test.js'))) {
    assert.ok(line.includes(FILE), `a line that names the file names its full path: ${line}`);
  }
});
