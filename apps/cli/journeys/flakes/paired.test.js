/** @pullboard-test-input source-tree */
import { flakyProject } from '../../../../packages/git/tests/fixtures/flakes.js';
import { writeTarget } from '../../../../packages/git/tests/fixtures/flakes.js';
import { targetRuns } from '../../../../packages/git/tests/fixtures/flakes.js';
import { assertReceipts } from '../../../../packages/git/tests/fixtures/flakes.js';
import { privateBuilder } from '../../../../packages/git/tests/fixtures/flakes.js';
import { commitCandidate } from '../../../../packages/git/tests/fixtures/flakes.js';
import { checkedItem } from '../../../../packages/git/tests/fixtures/flakes.js';
import '../../tests/fixtures/cases/quarantine.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { commitFixtureFiles } from '../../tests/fixtures/copy.js';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
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

for (const linkedTemp of [false, true]) test(linkedTemp
  ? 'a private verification accepts on one green check run through a symlinked temporary root [C7,V4,H16]'
  : 'an independent private verification accepts on one green check run and makes no pair [C7,V4,H16]', async t => {
  const box = flakyProject(t, { alwaysPass: 'controlled' });
  if (linkedTemp) {
    const alias = join(box.scratch, 'temporary-alias');
    symlinkSync(box.scratch, alias, 'dir');
    box.env.TMPDIR = alias;
  }
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  const claimed = await builder.call('claim', String(id));
  assert.equal(claimed.code, 0, JSON.stringify(claimed.document));
  commitCandidate(builder, 'chore: controlled review candidate');
  const submitted = await builder.call('submit', String(id));
  assert.equal(submitted.code, 0, 'the fixture submits with a real green proof before its external failure is enabled');
  const head = (await box.call('show', String(id))).document.item_commit;
  writeFileSync(box.counter, ''); writeFileSync(box.counter + '.mode', 'paired');
  const reviewer = privateBuilder(box);
  reviewer.git('checkout', '-q', '--detach', head);
  const result = await reviewer.call('verify', String(id), 'accept');
  // Changed today: the verify rerun of the check is a single green run (no CHECK_RED), so no diagnostic pair is made.
  assert.equal(result.code, 0, JSON.stringify(result.document));
  assert.equal(result.document.check, 'green');
  const item = (await box.call('show', String(id))).document;
  assert.equal(item.item_verdict, 'ACCEPT', 'verify accepts on its one green check run');
  assert.equal(targetRuns(box), 1, 'verify reruns the private check once, green, and nothing else');
  assert.equal((await box.call('flakes')).document.flakes.length, 0, 'a verdict records no flake observation');
});

test('a frozen private check that changes its source records no pair, and verify accepts on one run [C7,V4,H16]', async t => {
  const box = flakyProject(t, { alwaysPass: 'controlled' });
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  assert.equal((await builder.call('claim', String(id))).code, 0);
  writeTarget(builder.root, box.counter, 'controlled', 'controlled');
  builder.git('add', '-A'); builder.git('commit', '-q', '-m', 'chore: controlled private-check mutation');
  const submitted = await builder.call('submit', String(id));
  assert.equal(submitted.code, 0, JSON.stringify(submitted.document));
  const head = (await box.call('show', String(id))).document.item_commit;
  writeFileSync(box.counter, ''); writeFileSync(box.counter + '.mode', 'paired');
  const reviewer = privateBuilder(box);
  reviewer.git('checkout', '-q', '--detach', head);
  const result = await reviewer.call('verify', String(id), 'accept');
  // Changed today: verify runs the check once and accepts (no CHECK_RED), so no diagnostic pair is made.
  assert.equal(result.code, 0, JSON.stringify(result.document));
  assert.equal(targetRuns(box), 1, 'verify runs the changed private check once, with no diagnostic pair');
  const report = (await box.call('flakes')).document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified.length, 0, 'no unchanged-source pair or observation is recorded');
});
