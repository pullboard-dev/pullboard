/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/sandbox/index.js */
import { flakyProject } from '../../../../packages/git/tests/fixtures/flakes.js';
import { TITLE } from '../../../../packages/git/tests/fixtures/flakes.js';
import { targetRuns } from '../../../../packages/git/tests/fixtures/flakes.js';
import { assertReceipts } from '../../../../packages/git/tests/fixtures/flakes.js';
import * as nativeBoard from '../../../lib/index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { selectAffectedTests } from '../../../../packages/gate/index.js';
import { selectTestTreeGuards } from '../../../../packages/gate/index.js';
import '../../tests/fixtures/cases/quarantine.js';
/** @pullboard-test-input source-tree */
/** Native flake observations preserve the first red verdict and carry evidence into repair work [C7,D1,H16]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
