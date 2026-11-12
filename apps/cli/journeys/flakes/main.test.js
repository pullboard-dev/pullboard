/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/sandbox/index.js */
import { flakyProject } from '../../../../packages/git/tests/fixtures/flakes.js';
import { writeTarget } from '../../../../packages/git/tests/fixtures/flakes.js';
import { TITLE } from '../../../../packages/git/tests/fixtures/flakes.js';
import { targetRuns } from '../../../../packages/git/tests/fixtures/flakes.js';
import { assertReceipts } from '../../../../packages/git/tests/fixtures/flakes.js';
import { privateBuilder } from '../../../../packages/git/tests/fixtures/flakes.js';
import { commitCandidate } from '../../../../packages/git/tests/fixtures/flakes.js';
import { checkedItem } from '../../../../packages/git/tests/fixtures/flakes.js';
import * as nativeBoard from '../../../lib/index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { selectAffectedTests } from '../../../../packages/gate/index.js';
import { selectTestTreeGuards } from '../../../../packages/gate/index.js';
import '../../tests/fixtures/cases/quarantine.js';
/** @pullboard-test-input source-tree */
/** Native flake observations preserve the first red verdict and carry evidence into repair work [C7,D1,H16]. */
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { commitFixtureFiles } from '../../tests/fixtures/copy.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { openBoardForRead } from '../../../lib/index.js';
import { nudgeMainAudit } from '../../../../packages/gate/index.js';
import { nudgeSourceAdvances } from '../../../../packages/git/index.js';
import { runMainAudits } from '../../../../packages/gate/index.js';
import { hasSourceAdvanceJobs } from '../../../../packages/sandbox/index.js';
import { runSourceAdvances } from '../../../../packages/sandbox/index.js';
import { context } from '../../index.js';
import { ordered } from '../../index.js';
import { withBoard } from '../../index.js';
import { runSubmitGate } from '../../../../packages/gate/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { readMainAudit } from '../../../../packages/gate/index.js';
import { saveMainAudit } from '../../../../packages/gate/index.js';
import { landingLeaseState } from '../../../../packages/store/index.js';
import { executionServices } from '../../tests/fixtures/gate/execution.js';
import { flakeLedger } from '../../../../packages/flakes/index.js';
import { eventCauses } from '../../../../packages/store/index.js';

const workerServices = Object.freeze({ nativeBoard, openBoardForRead, selectors: { selectAffectedTests, selectTestTreeGuards },
  executionServices, context, ordered, withBoard, runSubmitGate, withFileLock,
  readMainAudit, saveMainAudit, landingLeaseState, testValue: { flakeLedger, eventCauses } });

/** Load the source worker from a fresh main clone, so the case never depends on the checkout type: the worker refuses to run from a linked worktree's code. */
async function mainSourceWorker(t) {
  const clone = mkdtempSync(join(tmpdir(), 'pullboard-main-code-'));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  runFixtureGit(['clone', '-q', '--no-hardlinks', join(import.meta.dirname, '../../../..'), clone], { cwd: tmpdir() });
  return (await import(pathToFileURL(join(clone, 'packages/sandbox/index.js')).href)).runSourceAdvances;
}

test('empty automatic wakes leave no advisory state in a private repository [C7,H16]', async t => {
  const box = flakyProject(t);
  const runSourceAdvances = await mainSourceWorker(t);
  const pullboard = join(repoInfo(box.root).commonDir, 'pullboard');
  assert.equal(await nudgeSourceAdvances(box.root, { workerUrl: new URL('../../src/io/landing/advance.js', import.meta.url), eligible: false }), null,
    'the foreground skips spawning a source worker when its exact native snapshot has no work');
  assert.equal(await nudgeMainAudit(box.root, new URL('../../src/io/landing/audit.js', import.meta.url)), null,
    'the foreground skips spawning an audit worker before explicit activation');
  assert.equal((await box.call('sentinel', 'run', '--health-only')).code, 0,
    'the real higher-layer CLI path completes a successful health-only command');
  assert.equal(existsSync(join(pullboard, 'source-advances')), false,
    "the real caller's explicit empty eligibility result avoids creating advisory state");
  await Promise.all([
    runSourceAdvances(box.root, randomUUID(), workerServices),
    runMainAudits(box.root, randomUUID(), {}, workerServices),
  ]);
  assert.equal(existsSync(join(pullboard, 'source-advances')), false,
    'a source worker with no eligible submissions leaves no lock or wake files');
  assert.equal(existsSync(join(pullboard, 'main-audits')), false,
    'an audit worker without the explicit activation leaves no directory');

  const sourceAdvances = join(pullboard, 'source-advances');
  mkdirSync(sourceAdvances, { recursive: true });
  writeFileSync(join(sourceAdvances, 'wake.json'), JSON.stringify({ generation: 1 }) + '\n');
  assert.equal(hasSourceAdvanceJobs(box.root, workerServices), true,
    'an already-issued wake remains work even when its current item snapshot is empty');
  await runSourceAdvances(box.root, randomUUID(), workerServices);
  assert.deepEqual(JSON.parse(readFileSync(join(sourceAdvances, 'settled.json'), 'utf8')).generation, 2,
    'the worker drains the preexisting generation and its own wake before returning');
  assert.equal(existsSync(join(sourceAdvances, 'owner.json')), false,
    'settled generations release their exact private owner');
  assert.equal(hasSourceAdvanceJobs(box.root, workerServices), true,
    'an existing advisory directory keeps later explicit wakes on the serialized drain path');
  await runSourceAdvances(box.root, randomUUID(), workerServices);
  assert.deepEqual(JSON.parse(readFileSync(join(sourceAdvances, 'settled.json'), 'utf8')).generation, 3,
    'an explicit later wake settles even after all source obligations are complete');
});

test('a red gate records one paired pass and drafts repair work on a second sighting [C7,D1,H16]', async t => {
  const box = flakyProject(t);
  const head = box.git('rev-parse', 'HEAD').trim();
  const first = await box.call('gate');
  assert.equal(first.code, 1, 'a paired pass never turns the original red gate green');
  assert.equal(first.document.green, false);
  if (targetRuns(box) !== 2) {
    const diagnostic = (await box.call('flakes')).document;
    const observation = diagnostic?.unclassified?.[0]?.observations?.[0];
    console.log(JSON.stringify({ flakeDiagnostic: diagnostic, originalBody: observation
      ? box.readData(join(box.root, '.git/pullboard', observation.original.artifact), 'utf8') : first.document.report }));
  }
  assert.equal(targetRuns(box), 2, 'the configured target executes once and gets exactly one paired rerun');
  const listed = await box.call('flakes');
  assert.equal(listed.code, 0);
  assert.equal(listed.document.flakes.length, 1);
  const row = listed.document.flakes[0];
  assert.equal(row.file, 'test/alternating.test.mjs');
  assert.equal(row.name, TITLE);
  assert.equal(row.count, 1);
  assert.equal(row.status, 'active');
  assert.equal(row.observations[0].head, head);
  assert.equal(row.observations[0].original.green, false);
  assert.equal(row.observations[0].paired.green, true);
  assertReceipts(box, row.observations[0]);
  // Changed with #3131: a proven ledger flake files its repair on the first sighting.
  assert.ok(Number.isSafeInteger(row.item), 'a proven flake files one repair item on its first sighting');
  const second = await box.call('gate');
  assert.equal(second.code, 1);
  assert.equal(second.document.green, false);
  assert.equal(targetRuns(box), 4, 'a second red adds one new pair, no confidence loop');
  const repeated = (await box.call('flakes')).document.flakes[0];
  assert.equal(repeated.count, 2);
  assert.ok(repeated.firstSeen <= repeated.lastSeen);
  assert.ok(Number.isSafeInteger(repeated.item), 'Rigor drafts one ordinary fix item after the second confirmed sighting');
  const item = (await box.call('show', String(repeated.item))).document;
  assert.equal(item.item_status, 'open');
  assert.match(item.item_title, /flaky test/iu);
  assert.match(item.item_brief, /original.*paired/isu, 'the repair work carries both observations as evidence');
  for (const observation of repeated.observations) assertReceipts(box, observation);
  const causes = (await box.call('rigor')).document.causes;
  assert.equal(causes.find(row => row.key === 'test:test/alternating.test.mjs::' + TITLE)?.occurrences, 2);
  assert.equal(box.git('status', '--porcelain').trim(), '', 'Rigor changes no source, spec or doctrine file');
  assert.equal(box.git('rev-parse', 'HEAD').trim(), head, 'diagnostics and drafting never move the source head');
});

test('the ledger records a red by default without running a second command [C7,H16]', async t => {
  const box = flakyProject(t, { rerun: null });
  assert.equal((await box.call('gate')).code, 1);
  assert.equal(targetRuns(box), 1);
  const report = (await box.call('flakes')).document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified.length, 1);
  const observation = report.unclassified[0].observations[0];
  assert.equal(observation.paired, null);
  assert.match(observation.reason, /off/iu);
  assertReceipts(box, observation);
});

test('an unsupported Node reporter stays unclassified rather than guessing a selector [C7,H16]', async t => {
  const box = flakyProject(t, { reporter: 'spec' });
  assert.equal((await box.call('gate')).code, 1);
  assert.equal(targetRuns(box), 1);
  const report = (await box.call('flakes')).document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assertReceipts(box, report.unclassified[0].observations[0]);
});

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
