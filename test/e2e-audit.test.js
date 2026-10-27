/** Value placement and incremental audit control contracts, without executing repository journeys [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoInfo } from '../src/git.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { indexedStageSelection, readPlacementIndex, writePlacementIndex } from '../src/test-economics-index.js';
import { packageBranchCoverage } from '../src/audit-coverage.js';
import {
  auditFailureItem,
  auditInterval,
  incrementalAudit,
  journeyReason,
  placementReport,
  placeTest,
  testsAtStage,
} from '../src/test-economics.js';

/** A complete audit inventory with known unit, landing-only and CLI journey inputs. */
function inventory() {
  const modules = new Map([['test/journey.test.js', "spawn(node, ['bin/pullboard.js'])"]]);
  const closures = new Map([
    ['test/unit.test.js', { files: ['test/unit.test.js', 'src/unit.js'], helpers: ['test/unit.test.js'] }],
    ['test/contract.test.js', { files: ['test/contract.test.js', 'src/unit.js'], helpers: ['test/contract.test.js'] }],
    ['test/journey.test.js', { files: ['test/journey.test.js', 'bin/pullboard.js'], helpers: ['test/journey.test.js'] }],
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
  assert.deepEqual(testsAtStage(report.files.map(row => row.file), report, 'submit'), ['test/unit.test.js']);
  assert.deepEqual(testsAtStage(report.files.map(row => row.file), report, 'landing'), ['test/contract.test.js']);
  assert.deepEqual(testsAtStage(report.files.map(row => row.file), report, 'audit'), ['test/journey.test.js', 'test/unknown.test.js']);
  assert.equal(report.files.find(row => row.file === 'test/unknown.test.js').reason, 'undeclared computed import');
  assert.ok(report.proposals.every(row => row.action.includes('person')));
  assert.ok(!report.proposals.some(row => /journey|unknown/u.test(row.file)), 'an audit tier alone is not evidence a file has low value');
  assert.equal(journeyReason({ files: ['src/one/a.js', 'src/two/b.js', 'relay/service.js'] }, new Map()), 'reaches three or more product areas');
  assert.deepEqual(testsAtStage(['test/new.test.js'], report, 'landing'), [], 'an unknown file never silently enters the paid landing set');
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
  assert.equal(unknown.tier, 'audit');
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
