/** @pullboard-test-input apps/cli/pullboard.js */
/** Value placement and incremental audit control contracts, without executing repository journeys [C7]. */
import { flakeLedger } from '../../../../../packages/flakes/index.js';
import { auditFailureItem as focusedAuditFailureItem } from '../../../../../packages/items/index.js';
import { eventCauses } from '../../../../../packages/store/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { repoInfo } from '../../../../../packages/git/index.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import { refreshTestPlacement } from '../../../../../packages/gate/index.js';
import { testValueReport } from '../../../../../packages/gate/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import {
  indexedStageSelection,
  readPlacementIndex,
  readPlacementReport,
  writePlacementIndex,
} from '../../../../../packages/gate/index.js';
import {
  mainAuditFixture,
  readAuditJob,
} from '../../../tests/fixtures/main/audit/project.js';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import {
  paidTests,
  placementLandingGate,
  placementLandingPlan,
  placementSubmitSelection,
  VALUE_GATE,
  valueGateCommand,
} from '../../../../../packages/gate/index.js';
import { packageBranchCoverage } from '../../../../../packages/gate/index.js';
import {
  auditFailureItem,
  auditInterval,
  incrementalAudit,
  journeyReason,
  placementReport,
  placeTest,
  testsAtStage,
} from '../../../../../packages/gate/index.js';

/** A complete audit inventory with known unit, landing-only and CLI journey inputs. */
function inventory() {
  const modules = new Map([['test/journey.test.js', "spawn(node, ['apps/cli/pullboard.js'])"]]);
  const closures = new Map([
    ['test/unit.test.js', { files: ['test/unit.test.js', 'src/unit.js'], helpers: ['test/unit.test.js'] }],
    ['test/contract.test.js', { files: ['test/contract.test.js', 'src/unit.js'], helpers: ['test/contract.test.js'] }],
    ['test/journey.test.js', { files: ['test/journey.test.js', 'apps/cli/pullboard.js'], helpers: ['test/journey.test.js'] }],
    ['test/unknown.test.js', { files: null, reason: 'undeclared computed import' }],
  ]);
  const observations = Object.fromEntries([...closures.keys()].map(file => [file, { runs: 10, realCatches: 1, flakes: 0,
    catchRate: 0.1, flakeRate: 0, meanRuntimeMs: file.includes('contract') ? 200000 : 1000, edits: 2 }]));
  return placementReport({ closures, modules, observations, head: 'a'.repeat(40), at: '2026-10-27T00:00:00Z' });
}

test('every file has recorded value placement; journeys are audit-only despite high catch value [C7]', () => {
  const report = inventory();
  assert.equal(report.files.length, 4);
  const unknown = placementReport({ closures: new Map([['test/new.test.js', { files: ['test/new.test.js'] }]]), modules: new Map() });
  assert.equal(unknown.files[0].realCatches, null, 'missing observation is unknown, not a measured zero');
  assert.equal(unknown.files[0].tier, 'landing', 'a known-reach contract starts at reach-selected landing while history is unknown');
  assert.deepEqual(testsAtStage(report.files.map(row => row.file), report, 'submit'), ['test/unit.test.js']);
  assert.deepEqual(testsAtStage(report.files.map(row => row.file), report, 'landing'), ['test/contract.test.js']);
  assert.deepEqual(testsAtStage(report.files.map(row => row.file), report, 'audit'), ['test/journey.test.js', 'test/unknown.test.js']);
  assert.equal(report.files.find(row => row.file === 'test/unknown.test.js').reason, 'undeclared computed import');
  assert.ok(report.proposals.every(row => row.action.includes('person')));
  assert.ok(!report.proposals.some(row => /journey|unknown/u.test(row.file)), 'an audit tier alone is not evidence a file has low value');
  assert.equal(journeyReason({ files: ['src/one/a.js', 'src/two/b.js', 'apps/relay/src/io/deploy/service.js'] }, new Map()), '', 'known imports are contracts across product areas');
  assert.deepEqual(testsAtStage(['test/new.test.js'], report, 'landing'), [], 'an unknown file never silently enters the paid landing set');
});

test('in-process CLI dispatch and source references are contracts while actual CLI child launches stay journeys [C7]', () => {
  const closure = { files: ['test/contract.test.js', 'src/cli.js'], helpers: ['test/contract.test.js'] };
  const source = "const bin = '../../../pullboard.js'; await runCliInProcess(['show', '1']);";
  assert.equal(journeyReason(closure, new Map([['test/contract.test.js', source]])), '');
  assert.equal(journeyReason(closure, new Map([['test/contract.test.js', "readFileSync('../../../pullboard.js');"]])), '');
  assert.match(journeyReason(closure, new Map([['test/contract.test.js', "spawnSync(process.execPath, ['apps/cli/pullboard.js']);"]])), /CLI-spawning/u);
  assert.match(journeyReason(closure, new Map([['test/contract.test.js', "const BIN = join(root, 'apps/cli/pullboard.js'); runFixtureChild(process.execPath, [BIN]);"]])), /CLI-spawning/u);
  assert.equal(journeyReason({ files: null, reason: 'undeclared reach' }, new Map()), 'undeclared reach');
});

test('an unchanged test is reused only from a complete green audit with the exact action key [C7]', () => {
  const keys = new Map([['test/a.test.js', { key: 'key-a' }], ['test/b.test.js', { key: 'key-b' }], ['test/unknown.test.js', { key: null }]]);
  const previous = { complete: true, green: true, receiptId: 'native-receipt', keys: { 'test/a.test.js': 'key-a', 'test/b.test.js': 'old-key' } };
  const plan = incrementalAudit(keys, previous);
  assert.deepEqual(plan.run, ['test/b.test.js', 'test/unknown.test.js']);
  assert.deepEqual(plan.reused, [{ file: 'test/a.test.js', key: 'key-a', origin: 'native-receipt' }]);
  for (const invalid of [{ ...previous, green: false }, { ...previous, complete: false }, null]) {
    assert.equal(incrementalAudit(keys, invalid).run.length, 3, 'red or incomplete audit results do not advance the reuse cursor');
  }
  keys.set('test/a.test.js', { key: 'changed-reached-module' });
  assert.equal(incrementalAudit(keys, previous).reused.length, 0);
});

test('optimal audit cadence changes with observed escapes and actual run and delay costs [C7]', () => {
  const base = { runCost: 100, escapes: 2, observationHours: 10, delayCost: 1000 };
  assert.equal(auditInterval(base).hours, 1);
  assert.equal(auditInterval({ ...base, escapes: 8 }).hours, 0.5);
  assert.equal(auditInterval({ ...base, runCost: 400 }).hours, 2);
  assert.equal(auditInterval({ ...base, delayCost: 4000 }).hours, 0.5);
  assert.equal(auditInterval({ ...base, escapes: 0 }).hours, null, 'zero observed escapes is not an invented positive rate');
  assert.throws(() => auditInterval({ ...base, observationHours: 0 }), TypeError);
});

test('an audit failure names exactly the landings since its last green event without blaming a test cause [C7]', () => {
  assert.equal(auditFailureItem, focusedAuditFailureItem, 'the preserved public export is the actual focused native payload builder');
  const landings = [{ eventId: 2, commit: 'old', items: [1] }, { eventId: 5, commit: 'new', items: [2, 3] }];
  const failure = auditFailureItem({ failures: [{ file: 'test/journey.test.js', name: 'the integration works' }], landings, sinceEventId: 3, lane: 'core' });
  assert.equal(failure.title, 'Main red: scheduled audit (test/journey.test.js)');
  assert.deepEqual(failure.audit.landings, [landings[1]]);
  assert.match(failure.criterion, /test\/journey.test.js: the integration works/u);
  assert.equal(Object.hasOwn(failure, 'cause'), false, 'ordinary main-red creation does not forge a reopen cause');
  assert.equal(auditFailureItem({ failures: [], landings, lane: 'core' }), null);
});

test('placement uses observed execution rates and labels runtime estimates without converting missing evidence to zero [C7]', () => {
  const observation = { runs: 2, realCatches: 3, flakes: 0, catchRate: 0.5, flakeRate: 0,
    meanRuntimeMs: 1000, edits: 0 };
  const measured = placeTest('test/unit.test.js', observation);
  assert.equal(measured.submitValue, 499, 'several repaired test names in one execution do not inflate catch probability');
  const unknown = placeTest('test/unit.test.js', { ...observation, catchRate: null });
  assert.equal(unknown.tier, 'landing', 'an unknown catch rate retains initial landing coverage without inventing a rate');
  assert.equal(unknown.submitValue, null);
  const estimated = placeTest('test/unit.test.js', { ...observation, meanRuntimeMs: null,
    lastObservedRuntime: { durationMs: 2000, source: 'landing-file-times', ageMs: null } });
  assert.equal(estimated.estimated, true);
  assert.equal(estimated.submitValue, 498);
  assert.equal(estimated.runtimeSource.ageMs, null);
});

test('gate placement reads only reached rows and invalidates changed test-side inputs [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', undefined, { withWorktree: false });
  const report = inventory();
  report.files.find(row => row.file === 'test/unit.test.js').testInputs.push('test/unit-fixture.js');
  const generation = writePlacementIndex(box.repo, report);
  const store = join(repoInfo(box.repo).commonDir, 'pullboard', 'test-value-index');
  const unrelatedName = createHash('sha256').update('test/contract.test.js').digest('hex') + '.json';
  writeFileSync(join(store, generation, unrelatedName), '{broken unrelated row');
  assert.deepEqual(indexedStageSelection(box.repo, ['test/unit.test.js'], 'submit'), ['test/unit.test.js']);
  assert.deepEqual(indexedStageSelection(box.repo, ['test/unit.test.js'], 'submit', ['test/unit-fixture.js']), []);
  assert.deepEqual(indexedStageSelection(box.repo, ['test/unit.test.js'], 'audit', ['test/unit-fixture.js']), ['test/unit.test.js']);
  assert.deepEqual(indexedStageSelection(box.repo, ['test/contract.test.js', 'test/new.test.js'], 'audit'), ['test/contract.test.js', 'test/new.test.js']);
  assert.ok(readFileSync(join(store, 'current.json')).length < 512, 'gate readers do not load the whole inventory');
  assert.equal(readPlacementIndex(box.repo, ['test/unit.test.js']).files.length, 1);
  assert.throws(() => writePlacementIndex(box.repo, { ...report, files: [report.files[0], report.files[0]] }), /duplicate/u);
  assert.equal(JSON.parse(readFileSync(join(store, 'current.json'))).generation, generation, 'invalid refresh leaves the prior published generation');
});

test('audit package coverage unions branch hits across shards and leaves unloaded product files unknown [C7]', () => {
  const options = { expectedFiles: ['packages/a/code.js', 'packages/b/code.js'],
    packages: [{ name: 'root', prefix: '' }, { name: 'a', prefix: 'packages/a' }, { name: 'b', prefix: 'packages/b' }] };
  /** Model Node's coverage event data only; these samples are not native execution receipts. */
  const sample = counts => ({ runtime: 'v22.13.1', summary: { workingDirectory: '/audit', files: [
    { path: '/audit/packages/a/code.js', totalBranchCount: 2, branches: counts.map(count => ({ line: 1, count })) },
    { path: '/foreign/code.js', totalBranchCount: 1, branches: [{ line: 1, count: 1 }] },
  ] } });
  const first = packageBranchCoverage([sample([1, 0])], options);
  assert.equal(first.find(row => row.package === 'a').percent, 50);
  assert.equal(first.find(row => row.package === 'b').percent, null);
  const combined = packageBranchCoverage([sample([1, 0]), sample([0, 1])], options);
  assert.equal(combined.find(row => row.package === 'a').branches, 2, 'shared branches are not added twice');
  assert.equal(combined.find(row => row.package === 'a').percent, 100);
  const changedRuntime = { ...sample([0, 1]), runtime: 'v24.21.0' };
  const incompatible = packageBranchCoverage([sample([1, 0]), changedRuntime], options);
  assert.deepEqual(incompatible.find(row => row.package === 'a').invalid, ['packages/a/code.js']);
  assert.equal(incompatible.find(row => row.package === 'a').percent, null);
});

test('production landing projection leaves CLI journeys for audit and preserves static and mandatory checks [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', undefined, { withWorktree: false });
  const report = inventory();
  const uncertain = { full: true, reason: 'undeclared reach', files: [] };
  assert.equal(placementSubmitSelection(box.repo, uncertain), uncertain, 'missing inventory preserves the original full-gate fallback');
  writePlacementIndex(box.repo, report);
  assert.deepEqual(placementSubmitSelection(box.repo, uncertain), { ...uncertain, full: false, files: [], reason: 'unknown reach deferred to audit: undeclared reach' });
  assert.deepEqual(placementSubmitSelection(box.repo, { full: false, files: report.files.map(row => row.file) }).files, ['test/unit.test.js']);
  const selected = placementLandingGate(box.repo, { gate: 'node bin/static.js && node packages/gate/src/io/run/tests.js' },
    { full: false, files: report.files.map(row => row.file) }, ['test/mandatory.test.js']);
  assert.match(selected.gate, /^node bin\/static.js &&/u);
  assert.match(selected.gate, /test\/contract\.test\.js/u);
  assert.match(selected.gate, /test\/mandatory\.test\.js/u);
  assert.doesNotMatch(selected.gate, /test\/journey\.test\.js|test\/unknown\.test\.js/u);
  assert.deepEqual(paidTests(box.repo, report.files.map(row => row.file), 'submit'), ['test/unit.test.js']);
  assert.equal(selected[VALUE_GATE], true, 'a selected gate cannot stamp full-suite green');
  const plan = placementLandingPlan(box.repo, { gate: 'node packages/gate/src/io/run/tests.js' },
    { full: false, files: report.files.map(row => row.file) }, ['test/mandatory.test.js', 'test/deferred.test.js']);
  assert.deepEqual(plan.files, ['test/contract.test.js', 'test/deferred.test.js', 'test/mandatory.test.js']);
  assert.equal(plan.subset, true, 'local-trunk composition retains selected-proof semantics and explicit deferred obligations');
  assert.match(plan.config.gate, /test\/deferred\.test\.js/u);

  assert.equal(valueGateCommand(box.repo, 'node packages/gate/src/io/run/tests.js --test-name-pattern=required', []), null, 'explicit check filters remain separate required obligations');
  assert.equal(valueGateCommand(box.repo, 'node packages/gate/src/io/run/tests.js | cat', []), null, 'opaque gate keeps legacy behavior');
});

test('production audit runs a CLI journey, reuses an unchanged unit and files a real main-red item for a seeded failure [C7]', { timeout: 180_000 }, async t => {
  const box = await mainAuditFixture(t, { initialGreen: true });
  runFixtureGit(['merge', '--ff-only', box.tip], { cwd: box.repo, env: box.env });
  await box.runWorker();
  const first = readAuditJob(box.directory, box.key);
  assert.equal(first.state, 'complete', JSON.stringify(first) + '\n' + readFileSync(join(box.directory, box.key, 'gate.log'), 'utf8'));
  assert.equal(first.green, true);
  assert.equal(box.readUnitMarker(), 'ran');
  const firstReceipt = box.readGateReceipt(box.receiptStore(box.repo), first.receiptId);
  assert.equal(firstReceipt.collection.full, true);
  const placement = readPlacementReport(box.repo);
  assert.equal(placement.files.find(row => row.file === 'test/a.test.js').tier, 'audit');
  assert.ok(first.plan.run.includes('test/a.test.js'), 'the actual CLI-spawning journey ran in the audit');
  assert.ok(first.coverage.samples > 0, 'coverage comes from actual Node events');
  assert.ok(first.coverage.packages.some(row => row.percent === null && row.missing.length), 'unloaded product coverage stays unknown');
  const secondBatch = box.appendBatch();
  await box.runWorker();
  const second = readAuditJob(box.directory, secondBatch.key);
  assert.equal(second.state, 'complete', JSON.stringify(second));
  assert.equal(second.green, true);
  assert.ok(second.plan.reused.some(row => row.file === 'test/b.test.js'));
  assert.ok(!second.plan.run.includes('test/b.test.js'));
  assert.equal(box.readUnitMarker(), 'ran', 'unchanged body was not executed again');
  assert.equal(box.readGateReceipt(box.receiptStore(box.repo), second.receiptId).collection.full, false, 'selected native proof is labeled selected');
  const failedBatch = box.appendBatch({ fail: true });
  await box.runWorker();
  const failed = readAuditJob(box.directory, failedBatch.key);
  assert.equal(failed.state, 'complete', JSON.stringify(failed));
  assert.equal(failed.green, false);
  const defects = box.board(db => box.store.landingTestDefects(db)).filter(row => row.batchId === failedBatch.batchId);
  assert.equal(defects.length, 1);
  const item = box.board(db => box.store.getItem(db, defects[0].item));
  assert.match(item.item_title, /^Main red: scheduled audit/u);
  assert.equal(item.item_status, 'open');
  assert.match(item.item_criterion, /audit seeded red/u);
  assert.ok(item.item_criterion.includes(failedBatch.tip));
  assert.ok(!item.item_criterion.includes(secondBatch.tip), 'the previous complete green landing is excluded');
  const cursor = JSON.parse(readFileSync(join(box.directory, 'last-green.json')));
  assert.equal(cursor.tip, secondBatch.tip, 'red audit cannot advance the green cursor');
  const cadence = JSON.parse(readFileSync(join(box.directory, 'schedule.json')));
  assert.equal(cadence.inputs.escapes, 1, 'lambda counts an actual audit-filed repair item');
  assert.ok(cadence.hours > 0);
  const report = box.board(db => testValueReport(db, { root: box.repo, costs: loadConfig(box.repo).testEconomics }, { flakeLedger, eventCauses }));
  const caught = report.files.find(row => row.file === 'test/a.test.js');
  assert.equal(caught.realCatches, 1, 'the routed native audit red earns a catch before a green repair exists');
  assert.equal(caught.catches[0].red, failed.receiptId);
  assert.equal(caught.catches[0].source, 'audit');
  assert.equal(caught.catches[0].green, null, 'a found regression never claims an unobserved green repair');
  assert.ok(caught.catchRate > 0);
  const promoted = box.board(db => refreshTestPlacement(db, { root: box.repo, head: failedBatch.tip, config: loadConfig(box.repo) }, { flakeLedger, eventCauses }));
  assert.ok(['submit', 'landing'].includes(promoted.files.find(row => row.file === 'test/a.test.js').tier),
    'a valuable caught contract can move back out of audit after the next inventory refresh');
});


test('a scheduled wake with no measured or finite cadence neither executes an audit nor writes board events [C7]', async t => {
  const box = await mainAuditFixture(t, { initialGreen: true });
  runFixtureGit(['merge', '--ff-only', box.tip], { cwd: box.repo, env: box.env });
  const before = box.board(db => box.store.events(db));
  await box.startWorker({ scheduled: true }).finish();
  assert.equal(existsSync(join(box.directory, box.key + '.json')), false);
  assert.deepEqual(box.board(db => box.store.events(db)), before, 'an unmeasured wake does not race an idle landing with a new fact');
  writeFileSync(join(box.directory, 'schedule.json'), JSON.stringify({ version: 1, dueAt: null }));
  await box.startWorker({ scheduled: true }).finish();
  assert.equal(existsSync(join(box.directory, box.key + '.json')), false);
  assert.deepEqual(box.board(db => box.store.events(db)), before, 'zero observed escapes cannot invent a finite scheduled audit');
});
