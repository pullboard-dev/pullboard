/** @pullboard-test-input source-tree */
import { settledCommit } from '../../../../packages/git/tests/fixtures/flakes.js';
import { flakyProject } from '../../../../packages/git/tests/fixtures/flakes.js';
import { writeTarget } from '../../../../packages/git/tests/fixtures/flakes.js';
import { targetRuns } from '../../../../packages/git/tests/fixtures/flakes.js';
import { assertReceipts } from '../../../../packages/git/tests/fixtures/flakes.js';
import { privateBuilder } from '../../../../packages/git/tests/fixtures/flakes.js';
import { checkedItem } from '../../../../packages/git/tests/fixtures/flakes.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { commitFixtureFiles } from '../../tests/fixtures/copy.js';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
/** Native flake observations: pinned runner, paired reruns and frozen checks [C7,D1,H16]. */

test('the pinned bundled runner selects one target and skips unrelated bodies [C7,H16]', async t => {
  const box = flakyProject(t);
  const unrelated = join(box.scratch, 'bundled-unrelated-runs');
  const copied = copyPackageFiles(resolve(import.meta.dirname, '../../../..'), box.root);
  /** Commit every copied manifest path through the fixture's real Git child and normal hooks. */
  const git = (_repo, ...args) => box.git(...args);
  commitFixtureFiles({ repo: box.root, git }, copied);
  writeFileSync(join(box.root, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.root, 'apps/cli/tests'), { recursive: true });
  writeFileSync(join(box.root, 'apps/cli/tests/unrelated.test.mjs'), `import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
test('unrelated bundled execution [C7]', () => appendFileSync(${JSON.stringify(unrelated)}, 'run\\n'));
`);
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.gate = 'node apps/cli/src/io/run/tests.js test/alternating.test.mjs apps/cli/tests/unrelated.test.mjs';
  config.affectedTests = 'node apps/cli/src/io/run/tests.js';
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'chore: private bundled runner');
  assert.equal((await box.call('gate')).code, 1);
  assert.equal(targetRuns(box), 2, 'the known pinned runner executes only its one exact-target pair');
  assert.equal(readFileSync(unrelated, 'utf8'), 'run\n', 'the unrelated body executes only in the original gate');
  const report = (await box.call('flakes')).document;
  assert.equal(report.flakes.length, 1);
  assert.equal(report.flakes[0].observations[0].paired.green, true);
  assertReceipts(box, report.flakes[0].observations[0]);
});

test('an unknown script named run-tests cannot rerun unrelated tests or confirm a flake [C7,H16]', async t => {
  const box = flakyProject(t);
  const unrelated = join(box.scratch, 'observed-unrelated-runs');
  mkdirSync(join(box.root, 'apps/cli/src/io/run'), { recursive: true });
  writeFileSync(join(box.root, 'apps/cli/src/io/run/tests.js'), `import { spawnSync } from 'node:child_process';
// This user's runner deliberately does not implement Node's test-name selector.
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/alternating.test.mjs', 'apps/cli/tests/unrelated.test.mjs'], { env: process.env, stdio: 'inherit' });
process.exitCode = run.status;
`);
  mkdirSync(join(box.root, 'apps/cli/tests'), { recursive: true });
  writeFileSync(join(box.root, 'apps/cli/tests/unrelated.test.mjs'), `import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
test('unrelated execution [C7]', () => appendFileSync(${JSON.stringify(unrelated)}, 'run\\n'));
`);
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.gate = 'node apps/cli/src/io/run/tests.js';
  config.affectedTests = 'node apps/cli/src/io/run/tests.js';
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'chore: private unknown runner');
  assert.equal((await box.call('gate')).code, 1, 'the original assertion remains red');
  assert.equal(targetRuns(box), 1, 'a conventional script filename does not authorize a paired rerun');
  assert.equal(readFileSync(unrelated, 'utf8'), 'run\n', 'the unrelated test runs only in the original gate');
  const report = (await box.call('flakes')).document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified.length, 1);
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assertReceipts(box, report.unclassified[0].observations[0]);
});

test('a green pinned main excludes a candidate that passes its paired rerun [C7,H16]', async t => {
  const box = flakyProject(t, { alwaysPass: true });
  const main = box.git('rev-parse', 'HEAD').trim();
  const builder = privateBuilder(box);
  writeTarget(builder.root, box.counter);
  builder.git('add', '-A'); builder.git('commit', '-q', '-m', 'chore: prepare private candidate');
  const head = builder.git('rev-parse', 'HEAD').trim();
  const gate = await builder.call('gate');
  assert.equal(gate.code, 1);
  assert.equal(gate.document.green, false);
  assert.equal(targetRuns(box), 3, 'one original, one candidate pair and one independently pinned main comparison');
  const report = (await box.call('flakes')).document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.regressions.length, 1);
  assert.equal(report.regressions[0].item, null);
  const observation = report.regressions[0].observations[0];
  assert.equal(observation.head, head);
  assert.equal(observation.main, main);
  assert.equal(observation.paired.green, true);
  assert.equal(observation.mainReceipt.green, true);
  assertReceipts(box, observation);
});

test('a source change during the original run prevents a paired measurement [C7,H16]', async t => {
  const box = flakyProject(t);
  writeTarget(box.root, box.counter, false, true);
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'chore: prepare controlled source mutation');
  assert.equal((await box.call('gate')).code, 1);
  assert.equal(targetRuns(box), 1);
  const report = (await box.call('flakes')).document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assert.match(report.unclassified[0].observations[0].reason, /changed/iu);
  assertReceipts(box, report.unclassified[0].observations[0]);
});

test('the actual check command retains its red and records one pair [C7,V2,H16]', async t => {
  const box = flakyProject(t);
  const id = checkedItem(box);
  const result = await box.call('check', String(id), '--yes');
  assert.equal(result.code, 1);
  assert.equal(result.document.green, false);
  assert.equal(targetRuns(box), 2);
  const observation = (await box.call('flakes')).document.flakes[0].observations[0];
  assert.equal(observation.kind, 'check');
  assert.equal(observation.original.green, false);
  assert.equal(observation.paired.green, true);
  assertReceipts(box, observation);
});
