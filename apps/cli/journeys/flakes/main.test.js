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
import { checkAtCommit } from '../../../runner/index.js';
/** @pullboard-test-input source-tree */
/** Native flake observations preserve the first red verdict and carry evidence into repair work [C7,D1,H16]. */
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { commitFixtureFiles } from '../../tests/fixtures/copy.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { cpSync } from 'node:fs';
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
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { flakeSource } from '../../../../packages/flakes/index.js';
import { observeNativeFailure } from '../../../../packages/flakes/index.js';
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

const CI_ROOT = join(tmpdir(), 'pullboard-ci-runner', 'repo');

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
  assert.equal(box.cli('sentinel', 'run', '--health-only').code, 0,
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

test('a red gate records one paired pass and drafts repair work on a second sighting [C7,D1,H16]', t => {
  const box = flakyProject(t);
  const head = box.git('rev-parse', 'HEAD').trim();
  const first = box.cli('gate');
  assert.equal(first.code, 1, 'a paired pass never turns the original red gate green');
  assert.equal(first.document.green, false);
  if (targetRuns(box) !== 2) {
    const diagnostic = box.cli('flakes').document;
    const observation = diagnostic?.unclassified?.[0]?.observations?.[0];
    console.log(JSON.stringify({ flakeDiagnostic: diagnostic, originalBody: observation
      ? box.readData(join(box.root, '.git/pullboard', observation.original.artifact), 'utf8') : first.document.report }));
  }
  assert.equal(targetRuns(box), 2, 'the configured target executes once and gets exactly one paired rerun');
  const listed = box.cli('flakes');
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
  const second = box.cli('gate');
  assert.equal(second.code, 1);
  assert.equal(second.document.green, false);
  assert.equal(targetRuns(box), 4, 'a second red adds one new pair, no confidence loop');
  const repeated = box.cli('flakes').document.flakes[0];
  assert.equal(repeated.count, 2);
  assert.ok(repeated.firstSeen <= repeated.lastSeen);
  assert.ok(Number.isSafeInteger(repeated.item), 'Rigor drafts one ordinary fix item after the second confirmed sighting');
  const item = box.cli('show', String(repeated.item)).document;
  assert.equal(item.item_status, 'open');
  assert.match(item.item_title, /flaky test/iu);
  assert.match(item.item_brief, /original.*paired/isu, 'the repair work carries both observations as evidence');
  for (const observation of repeated.observations) assertReceipts(box, observation);
  const causes = box.cli('rigor').document.causes;
  assert.equal(causes.find(row => row.key === 'test:test/alternating.test.mjs::' + TITLE)?.occurrences, 2);
  assert.equal(box.git('status', '--porcelain').trim(), '', 'Rigor changes no source, spec or doctrine file');
  assert.equal(box.git('rev-parse', 'HEAD').trim(), head, 'diagnostics and drafting never move the source head');
});

test('the ledger records a red by default without running a second command [C7,H16]', t => {
  const box = flakyProject(t, { rerun: null });
  assert.equal(box.cli('gate').code, 1);
  assert.equal(targetRuns(box), 1);
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified.length, 1);
  const observation = report.unclassified[0].observations[0];
  assert.equal(observation.paired, null);
  assert.match(observation.reason, /off/iu);
  assertReceipts(box, observation);
});

test('an unsupported Node reporter stays unclassified rather than guessing a selector [C7,H16]', t => {
  const box = flakyProject(t, { reporter: 'spec' });
  assert.equal(box.cli('gate').code, 1);
  assert.equal(targetRuns(box), 1);
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assertReceipts(box, report.unclassified[0].observations[0]);
});

test('the pinned bundled runner selects one target and skips unrelated bodies [C7,H16]', t => {
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
  assert.equal(box.cli('gate').code, 1);
  assert.equal(targetRuns(box), 2, 'the known pinned runner executes only its one exact-target pair');
  assert.equal(readFileSync(unrelated, 'utf8'), 'run\n', 'the unrelated body executes only in the original gate');
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 1);
  assert.equal(report.flakes[0].observations[0].paired.green, true);
  assertReceipts(box, report.flakes[0].observations[0]);
});

test('an unknown script named run-tests cannot rerun unrelated tests or confirm a flake [C7,H16]', t => {
  const box = flakyProject(t);
  const unrelated = join(box.scratch, 'observed-unrelated-runs');
  mkdirSync(join(box.root, 'packages/gate/src/io/run'), { recursive: true });
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
  assert.equal(box.cli('gate').code, 1, 'the original assertion remains red');
  assert.equal(targetRuns(box), 1, 'a conventional script filename does not authorize a paired rerun');
  assert.equal(readFileSync(unrelated, 'utf8'), 'run\n', 'the unrelated test runs only in the original gate');
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified.length, 1);
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assertReceipts(box, report.unclassified[0].observations[0]);
});

test('a green pinned main excludes a candidate that passes its paired rerun [C7,H16]', t => {
  const box = flakyProject(t, { alwaysPass: true });
  const main = box.git('rev-parse', 'HEAD').trim();
  const builder = privateBuilder(box);
  writeTarget(builder.root, box.counter);
  builder.git('add', '-A'); builder.git('commit', '-q', '-m', 'chore: prepare private candidate');
  const head = builder.git('rev-parse', 'HEAD').trim();
  const gate = builder.cli('gate');
  assert.equal(gate.code, 1);
  assert.equal(gate.document.green, false);
  assert.equal(targetRuns(box), 3, 'one original, one candidate pair and one independently pinned main comparison');
  const report = box.cli('flakes').document;
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

test('a source change during the original run prevents a paired measurement [C7,H16]', t => {
  const box = flakyProject(t);
  writeTarget(box.root, box.counter, false, true);
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'chore: prepare controlled source mutation');
  assert.equal(box.cli('gate').code, 1);
  assert.equal(targetRuns(box), 1);
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assert.match(report.unclassified[0].observations[0].reason, /changed/iu);
  assertReceipts(box, report.unclassified[0].observations[0]);
});

test('the actual check command retains its red and records one pair [C7,V2,H16]', t => {
  const box = flakyProject(t);
  const id = checkedItem(box);
  const result = box.cli('check', String(id), '--yes');
  assert.equal(result.code, 1);
  assert.equal(result.document.green, false);
  assert.equal(targetRuns(box), 2);
  const observation = box.cli('flakes').document.flakes[0].observations[0];
  assert.equal(observation.kind, 'check');
  assert.equal(observation.original.green, false);
  assert.equal(observation.paired.green, true);
  assertReceipts(box, observation);
});

test('a red submit records diagnostics without submitting the item [C7,V4,H16]', t => {
  const box = flakyProject(t);
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  const claimed = builder.cli('claim', String(id));
  assert.equal(claimed.code, 0, JSON.stringify(claimed.document));
  commitCandidate(builder, 'chore: controlled submission candidate');
  const result = builder.cli('submit', String(id));
  assert.equal(result.code, 1);
  assert.equal(box.cli('show', String(id)).document.item_status, 'claimed');
  // Changed today with the submit/landing rerun change: a red submit runs the target four times, and its pair stays red beside a green pinned main.
  assert.equal(targetRuns(box), 4, 'a red submit runs the target four times');
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0, 'a candidate whose pair stays red is no flake');
  const observation = report.regressions[0].observations[0];
  assert.equal(observation.kind, 'submit');
  assert.equal(observation.original.green, false);
  assert.equal(observation.paired.green, false);
  assert.equal(observation.mainReceipt.green, true);
  assertReceipts(box, observation);
});

for (const linkedTemp of [false, true]) test(linkedTemp
  ? 'a private verification accepts on one green check run through a symlinked temporary root [C7,V4,H16]'
  : 'an independent private verification accepts on one green check run and makes no pair [C7,V4,H16]', t => {
  const box = flakyProject(t, { alwaysPass: 'controlled' });
  if (linkedTemp) {
    const alias = join(box.scratch, 'temporary-alias');
    symlinkSync(box.scratch, alias, 'dir');
    box.env.TMPDIR = alias;
  }
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  const claimed = builder.cli('claim', String(id));
  assert.equal(claimed.code, 0, JSON.stringify(claimed.document));
  commitCandidate(builder, 'chore: controlled review candidate');
  const submitted = builder.cli('submit', String(id));
  assert.equal(submitted.code, 0, 'the fixture submits with a real green proof before its external failure is enabled');
  const head = box.cli('show', String(id)).document.item_commit;
  writeFileSync(box.counter, ''); writeFileSync(box.counter + '.mode', 'paired');
  const reviewer = privateBuilder(box);
  reviewer.git('checkout', '-q', '--detach', head);
  const result = reviewer.cli('verify', String(id), 'accept');
  // Changed today: the verify rerun of the check is a single green run (no CHECK_RED), so no diagnostic pair is made.
  assert.equal(result.code, 0, JSON.stringify(result.document));
  assert.equal(result.document.check, 'green');
  const item = box.cli('show', String(id)).document;
  assert.equal(item.item_verdict, 'ACCEPT', 'verify accepts on its one green check run');
  assert.equal(targetRuns(box), 1, 'verify reruns the private check once, green, and nothing else');
  assert.equal(box.cli('flakes').document.flakes.length, 0, 'a verdict records no flake observation');
});

test('a frozen private check that changes its source records no pair, and verify accepts on one run [C7,V4,H16]', t => {
  const box = flakyProject(t, { alwaysPass: 'controlled' });
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  assert.equal(builder.cli('claim', String(id)).code, 0);
  writeTarget(builder.root, box.counter, 'controlled', 'controlled');
  builder.git('add', '-A'); builder.git('commit', '-q', '-m', 'chore: controlled private-check mutation');
  const submitted = builder.cli('submit', String(id));
  assert.equal(submitted.code, 0, JSON.stringify(submitted.document));
  const head = box.cli('show', String(id)).document.item_commit;
  writeFileSync(box.counter, ''); writeFileSync(box.counter + '.mode', 'paired');
  const reviewer = privateBuilder(box);
  reviewer.git('checkout', '-q', '--detach', head);
  const result = reviewer.cli('verify', String(id), 'accept');
  // Changed today: verify runs the check once and accepts (no CHECK_RED), so no diagnostic pair is made.
  assert.equal(result.code, 0, JSON.stringify(result.document));
  assert.equal(targetRuns(box), 1, 'verify runs the changed private check once, with no diagnostic pair');
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified.length, 0, 'no unchanged-source pair or observation is recorded');
});

test('a ledger recording failure cannot replace the original red or discard its evidence [C7,H16]', async t => {
  const box = flakyProject(t, { rerun: false });
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  const pin = flakeSource(box.root);
  const result = runFixtureChild(process.execPath, ['--test', '--test-reporter=tap', 'test/alternating.test.mjs'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 1, 'the original assertion really failed before the forced recording error');
  const run = { isGreen: false, output: result.stdout + result.stderr };
  const notices = [];
  await observeNativeFailure({ root: box.root, config, pin, run, checkAtCommit, command: config.gate, kind: 'check',
    record: () => { throw Object.assign(new Error('private injected ledger failure'), { code: 'SYNTHETIC_LEDGER_UNAVAILABLE' }); },
    onError: notice => notices.push(notice),
  });
  assert.equal(run.isGreen, false);
  assert.equal(targetRuns(box), 1, 'a recording failure adds no execution');
  assert.equal(run.flakeDiagnostics.error, 'SYNTHETIC_LEDGER_UNAVAILABLE');
  assert.equal(run.flakeDiagnostics.observations[0].recorded, false, 'the result never claims the missing ledger entry was recorded');
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /original result stays red/u);
  const directory = join(box.root, '.git/pullboard/flake-evidence', run.flakeDiagnostics.observations[0].id);
  const retained = JSON.parse(readFileSync(join(directory, 'observation.json'), 'utf8'));
  assertReceipts(box, retained);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  for (const [file, digest] of Object.entries(manifest)) assert.equal(createHash('sha256').update(box.readData(join(directory, file))).digest('hex'), digest);
  assert.equal(Object.hasOwn(manifest, 'recording-error.addendum.json'), false, 'the original manifest remains immutable');
  assert.equal(JSON.parse(readFileSync(join(directory, 'recording-error.addendum.json'), 'utf8')).code, 'SYNTHETIC_LEDGER_UNAVAILABLE');
});

/** Save one CI attempt as the importer reads it: a manifest beside its TAP report. */
function ciAttempt(folder, name, manifest, tap) {
  const directory = join(folder, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'run.tap'), tap);
  writeFileSync(join(directory, 'ci-result.json'), JSON.stringify({ provider: 'github', root: CI_ROOT, tap: 'run.tap', ...manifest }));
}

test('a CI job red then green on its rerun is one flake, and a CI failure with no test names stays unclassified [C7,H16]', t => {
  const box = flakyProject(t);
  const commit = box.git('rev-parse', 'HEAD').trim();
  const ci = join(box.scratch, 'ci-results');
  const location = `  location: '${CI_ROOT}/test/alternating.test.mjs:3:1'\n`;
  const job = { job: 'linux (22.13.1) 1/2', runner: 'ubuntu-24.04', node: 'v22.13.1', commit, at: '2026-10-20T10:00:00.000Z' };
  ciAttempt(ci, 'run-111-1', { ...job, run: '111', attempt: 1, conclusion: 'failure' }, `TAP version 13\nnot ok 1 - ${TITLE}\n  ---\n${location}  ...\n1..1\n`);
  ciAttempt(ci, 'run-111-2', { ...job, run: '111', attempt: 2, conclusion: 'success' }, `TAP version 13\nok 1 - ${TITLE}\n  ---\n${location}  ...\n1..1\n`);
  const crash = { job: 'macos (22.13.1) 2/2', runner: 'macos-15', node: 'v22.13.1', commit, at: '2026-10-20T11:00:00.000Z' };
  ciAttempt(ci, 'run-222-1', { ...crash, run: '222', attempt: 1, conclusion: 'failure' }, 'TAP version 13\nnot ok 1 - the shard stopped before its tests reported\n1..1\n');
  ciAttempt(ci, 'run-222-2', { ...crash, run: '222', attempt: 2, conclusion: 'success' }, 'TAP version 13\n1..0\n');

  const imported = box.cli('flakes', 'import', ci);
  assert.equal(imported.code, 0, JSON.stringify(imported.document));
  assert.equal(imported.document.imported.length, 2);
  const listed = box.cli('flakes').document;
  assert.equal(listed.flakes.length, 1, 'the red-then-green CI pair is one flake');
  const flake = listed.flakes[0].observations[0];
  assert.equal(listed.flakes[0].file, 'test/alternating.test.mjs', 'the CI location resolves inside the CI checkout');
  assert.equal(listed.flakes[0].name, TITLE);
  assert.equal(flake.kind, 'ci');
  assert.deepEqual(flake.ci, { provider: 'github', run: '111', attempt: 1, rerunAttempt: 2, job: job.job, runner: job.runner, node: job.node });
  assert.equal(flake.head, commit);
  assert.equal(flake.original.green, false, 'the original CI red is kept');
  assert.equal(flake.paired.green, true);
  assert.equal(flake.load, null, 'a hosted runner reports no host load, and none is invented');
  assertReceipts(box, flake);
  const unnamed = listed.unclassified.flatMap(row => row.observations).find(entry => entry.ci?.run === '222');
  assert.ok(unnamed, 'the CI failure with no test named by file is recorded');
  assert.equal(unnamed.file, null);
  assert.equal(unnamed.classification, 'unclassified');
  assert.match(unnamed.reason, /no test named by file/u);

  const again = box.cli('flakes', 'import', ci);
  assert.equal(again.code, 0);
  assert.ok(again.document.imported.every(entry => entry.duplicate), 'importing the same CI results again records nothing new');
  assert.equal(box.cli('flakes').document.flakes[0].count, 1);
});

test('a CI rerun that names its passing test without a location still pairs, and kept CI evidence is never replaced [C7,H16]', t => {
  const box = flakyProject(t);
  const commit = box.git('rev-parse', 'HEAD').trim();
  const ci = join(box.scratch, 'ci-results');
  const job = { job: 'linux (24) 2/2', runner: 'ubuntu-24.04', node: 'v24.11.0', commit, run: '444', at: '2026-10-20T12:00:00.000Z' };
  const red = `TAP version 13\nnot ok 1 - ${TITLE}\n  ---\n  location: '${CI_ROOT}/test/alternating.test.mjs:3:1'\n  ...\n1..1\n`;
  ciAttempt(ci, 'run-444-1', { ...job, attempt: 1, conclusion: 'failure' }, red);
  // As Node's TAP reporter writes it: a passing test carries no location.
  ciAttempt(ci, 'run-444-2', { ...job, attempt: 2, conclusion: 'success' }, `TAP version 13\nok 1 - ${TITLE}\n  ---\n  duration_ms: 1.2\n  ...\n1..1\n`);
  assert.equal(box.cli('flakes', 'import', ci).code, 0);
  const flake = box.cli('flakes').document.flakes[0]?.observations[0];
  assert.equal(flake?.classification, 'flake', 'the rerun row matches by its name when it carries no location');
  const kept = join(box.root, '.git/pullboard', flake.original.artifact);
  const before = box.readData(kept);
  // The downloaded red report changes by one comment line; the ledger refuses it, and the kept original is untouched.
  writeFileSync(join(ci, 'run-444-1', 'run.tap'), red + '# re-downloaded\n');
  const changed = box.cli('flakes', 'import', ci);
  assert.equal(changed.code, 1);
  assert.equal(changed.document.error.code, 'FLAKE_OBSERVATION_CHANGED');
  assert.deepEqual(box.readData(kept), before, 'the original red evidence keeps its recorded bytes');
  assertReceipts(box, flake);
});


test('a CI passing title cannot prove two files when the other rerun skips [C7,H16]', t => {
  const box = flakyProject(t);
  for (const suffix of ['a', 'b']) {
    writeFileSync(join(box.root, `test/ci-${suffix}.test.mjs`), `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('the shared title [C7]', { skip: process.env.CI_DUPLICATE_MODE === 'rerun' && ${suffix === 'b'} }, () => {
  assert.equal(process.env.CI_DUPLICATE_MODE, 'rerun');
});\n`);
  }
  box.git('add', 'test/ci-a.test.mjs', 'test/ci-b.test.mjs');
  box.git('commit', '-q', '-m', 'test: prepare fixed duplicate-title CI source');
  const commit = box.git('rev-parse', 'HEAD');
  const command = ['--test', '--test-reporter=tap', 'test/ci-a.test.mjs', 'test/ci-b.test.mjs'];
  const red = runFixtureChild(process.execPath, command, { cwd: box.root, env: { ...box.env, CI_DUPLICATE_MODE: 'red' }, encoding: 'utf8' });
  const rerun = runFixtureChild(process.execPath, command, { cwd: box.root, env: { ...box.env, CI_DUPLICATE_MODE: 'rerun' }, encoding: 'utf8' });
  t.diagnostic(JSON.stringify({ commit, node: process.version, red: red.stdout, rerun: rerun.stdout }));
  assert.equal(red.status, 1, red.failure);
  assert.equal(rerun.status, 0, rerun.failure);
  assert.match(red.stdout, /^# fail 2$/mu);
  assert.match(rerun.stdout, /^# pass 1$/mu);
  assert.match(rerun.stdout, /^# skipped 1$/mu);
  assert.equal(box.git('rev-parse', 'HEAD'), commit);
  assert.equal(box.git('status', '--porcelain'), '', 'the two attempts use identical committed source');
  const ci = join(box.scratch, 'ci-results');
  const job = { job: 'duplicate titles', runner: 'private-node-fixture', node: process.version, commit, root: box.root, run: '555', at: '2026-10-20T12:00:00.000Z' };
  ciAttempt(ci, 'red', { ...job, attempt: 1, conclusion: 'failure' }, red.stdout);
  ciAttempt(ci, 'rerun', { ...job, attempt: 2, conclusion: 'success' }, rerun.stdout);
  const imported = box.cli('flakes', 'import', ci);
  assert.equal(imported.code, 0, JSON.stringify(imported.document));
  const listed = box.cli('flakes').document;
  assert.equal(listed.flakes.length, 0, 'one anonymous pass cannot prove either of two same-title files green');
  assert.deepEqual(listed.unclassified.map(row => row.file).sort(), ['test/ci-a.test.mjs', 'test/ci-b.test.mjs']);
  for (const row of listed.unclassified) assertReceipts(box, row.observations[0]);
});

test('a CI rerun matches an explicit file before considering anonymous same-title rows [C7,H16]', t => {
  const box = flakyProject(t);
  const commit = box.git('rev-parse', 'HEAD');
  const ci = join(box.scratch, 'ci-results');
  const job = { job: 'explicit and anonymous', runner: 'private-tap-fixture', node: process.version, commit, run: '666', at: '2026-10-20T12:00:00.000Z' };
  const row = (status, number, file) => `${status} ${number} - shared title [C7]\n  ---\n${file ? `  location: '${CI_ROOT}/${file}:3:1'\n` : ''}  ...\n`;
  ciAttempt(ci, 'red', { ...job, attempt: 1, conclusion: 'failure' }, `TAP version 13\n${row('not ok', 1, 'test/a.test.mjs')}${row('not ok', 2, 'test/b.test.mjs')}1..2\n`);
  ciAttempt(ci, 'rerun', { ...job, attempt: 2, conclusion: 'success' }, `TAP version 13\n${row('ok', 1, 'test/a.test.mjs')}${row('ok', 2, null)}1..2\n`);
  const imported = box.cli('flakes', 'import', ci);
  assert.equal(imported.code, 0, JSON.stringify(imported.document));
  const listed = box.cli('flakes').document;
  assert.deepEqual(listed.flakes.map(entry => entry.file), ['test/a.test.mjs'], 'the explicitly located passing row proves its own file');
  assert.deepEqual(listed.unclassified.map(entry => entry.file), ['test/b.test.mjs'], 'the anonymous row remains ambiguous');
});


test('a same-title skipped original does not lend its identity to an anonymous CI pass [C7,H16]', t => {
  const box = flakyProject(t);
  const commit = box.git('rev-parse', 'HEAD');
  const ci = join(box.scratch, 'ci-results');
  const job = { job: 'original ambiguity', runner: 'private-tap-fixture', node: process.version, commit, run: '777', at: '2026-10-20T12:00:00.000Z' };
  ciAttempt(ci, 'red', { ...job, attempt: 1, conclusion: 'failure' }, `TAP version 13\nnot ok 1 - shared title [C7]\n  ---\n  location: '${CI_ROOT}/test/a.test.mjs:3:1'\n  ...\nok 2 - shared title [C7] # SKIP\n1..2\n`);
  ciAttempt(ci, 'rerun', { ...job, attempt: 2, conclusion: 'success' }, 'TAP version 13\nok 1 - shared title [C7]\n1..1\n');
  const imported = box.cli('flakes', 'import', ci);
  assert.equal(imported.code, 0, JSON.stringify(imported.document));
  const listed = box.cli('flakes').document;
  assert.equal(listed.flakes.length, 0, 'the anonymous pass could be the other original test');
  assert.deepEqual(listed.unclassified.map(entry => entry.file), ['test/a.test.mjs'], 'the skipped original is not itself recorded as a failure');
});

test('a duplicate original CI file and title cannot share one located passing occurrence [C7,H16]', t => {
  const box = flakyProject(t);
  const commit = box.git('rev-parse', 'HEAD');
  const ci = join(box.scratch, 'ci-results');
  const job = { job: 'duplicate original identity', runner: 'private-tap-fixture', node: process.version, commit, run: '888', at: '2026-10-20T12:00:00.000Z' };
  const row = (status, number) => `${status} ${number} - shared title [C7]\n  ---\n  location: '${CI_ROOT}/test/shared.test.mjs:3:1'\n  ...\n`;
  ciAttempt(ci, 'red', { ...job, attempt: 1, conclusion: 'failure' }, `TAP version 13\n${row('not ok', 1)}${row('not ok', 2)}1..2\n`);
  ciAttempt(ci, 'rerun', { ...job, attempt: 2, conclusion: 'success' }, `TAP version 13\n${row('ok', 1)}1..1\n`);
  const imported = box.cli('flakes', 'import', ci);
  assert.equal(imported.code, 0, JSON.stringify(imported.document));
  const listed = box.cli('flakes').document;
  assert.equal(listed.flakes.length, 0, 'a located pass cannot identify which duplicate original occurrence passed');
  assert.deepEqual(listed.unclassified.map(entry => entry.file), ['test/shared.test.mjs']);
  assertReceipts(box, listed.unclassified[0].observations[0]);
});
