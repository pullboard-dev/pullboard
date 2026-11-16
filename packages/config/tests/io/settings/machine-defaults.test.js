/** @pullboard-test-input source-cell config */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MACHINE_DEFAULTS } from '../../../src/io/settings/machine-defaults.js';

const FILE = new URL('../../../src/io/settings/machine-defaults.js', import.meta.url);
const INVENTORY = new URL('../../../src/io/settings/inventory.js', import.meta.url);

/** The key/default list as it stood before the move [O5,O6]. */
const BEFORE = {
  'add.warnUnnamedTest': false,
  'browserSlots': 1,
  'budget.dailyUsd': null,
  'budget.totalUsd': null,
  'census.balanceByTime': false,
  'census.jobMinutes': null,
  'census.jobsPerRunner': null,
  'census.recordFileTimes': false,
  'census.rerunNonGreen': false,
  'census.rerunOnSettle': false,
  'claim.refuseOffMainHead': false,
  'freeze.refuseEmptyBar': false,
  'gate.browserByLaunch': false,
  'gate.browserFreeChecks': false,
  'gate.diskFloorMB': 10240,
  'gate.endStaleJobs': false,
  'gate.fencedHop': true,
  'gate.handoffWorkers': null,
  'gate.jobReserve': null,
  'gate.loadAwareDispatch': true,
  'gate.localLoadShare': 1,
  'gate.localRunner': true,
  'gate.mainCaseFilter': false,
  'gate.mainComparison': 'on-red',
  'gate.measuredSlots': false,
  'gate.memoryFloorMB': null,
  'gate.namedImportSelection': false,
  'gate.postLandSuite': false,
  'gate.queue.agingMinutes': 30,
  'gate.queue.currentReleaseFirst': false,
  'gate.queue.reviewsFirst': false,
  'gate.recaptureHandoff': false,
  'gate.redFactLocation': false,
  'gate.refuseMissingCheckFile': false,
  'gate.refuseTempWorktree': false,
  'gate.requireRunnerAttribution': false,
  'gate.runnerBusyCeiling': 90,
  'gate.runnerDispatch': 'pull',
  'gate.runnerWaitMs': 300000,
  'gate.runnersFirst': false,
  'gate.runnersOnly': false,
  'gate.sampleDiskIo': false,
  'gate.settleOnMainReceipt': false,
  'gate.shortSlots': 0,
  'gate.staticMemo': false,
  'gate.staticSlots': 2,
  'gate.submitAuthorization': 'runner',
  'gate.tableReplay': false,
  'gate.testNice': false,
  'gate.timingRunner': 'auto',
  'gate.tripOverheadBudgetMs': 10000,
  'gateSlots': 2,
  'health.derivedState': false,
  'health.diskFloorGb': 0,
  'health.lapsedSweep': false,
  'health.sentinel': true,
  'holds.requireOwner': false,
  'inspection.clauses': false,
  'items.typedFields': false,
  'jobs.avoidRunners': false,
  'jobs.handBackUnrunnable': false,
  'landing.pools': [],
  'landing.reofferTrunkBusy': false,
  'landing.reuseContractResults': false,
  'landing.reuseGateReceipts': false,
  'landing.squash': false,
  'landing.strictFullSuite': false,
  'list.thinRead': false,
  'maintenance.retireIdleHours': 3,
  'maintenance.retireIdleSeats': false,
  'moves.live.claim': false,
  'moves.live.handoff': false,
  'moves.live.job': false,
  'moves.live.outbox': false,
  'moves.live.outcome': false,
  'moves.live.reopen': false,
  'moves.live.submit': false,
  'moves.shadow': false,
  'next.itemNotices': false,
  'next.readinessCheck': false,
  'push.rerunFailedShardOnce': false,
  'relay.excludeByBoard': false,
  'relay.offerAtInit': true,
  'relay.pruneReceipts': false,
  'review.releaseReasons': false,
  'runner.packCache': false,
  'runnerRates': {},
  'runners': [],
  'runners.drainOnFetchFailure': false,
  'runners.fetchFailFast': false,
  'runners.postedLineNamesCase': false,
  'runners.yieldWhilePruning': false,
  'scratch': null,
  'sentinels.recordWriteHolder': false,
  'serve.address': '127.0.0.1',
  'serve.port': 0,
  'spec.cascadeReject': false,
  'spec.commitOnApply': false,
  'submit.proofOnly': false,
  'test.statusOutcomes': false,
  'tests.registryStrict': false,
  'tests.requireRegistered': false,
  'view.background': true,
};

test('clause 1: every machine default key sits on its own line, in sorted order [O5]', () => {
  const lines = readFileSync(FILE, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('export const MACHINE_DEFAULTS = {'));
  const end = lines.findIndex((line, i) => i > start && line === '};');
  const body = lines.slice(start + 1, end);
  const keys = Object.keys(MACHINE_DEFAULTS);
  assert.equal(body.length, keys.length);
  body.forEach((line, i) => {
    assert.ok(line.startsWith('  ') && line.endsWith(','), `line ${i} is not a single entry: ${line}`);
    assert.ok(line.includes(keys[i]), `line ${i} does not hold ${keys[i]}`);
  });
  assert.deepEqual(keys, [...keys].sort());
});

test('clause 2: the machine defaults hold the same keys and values as before the move [O6]', () => {
  assert.deepEqual(MACHINE_DEFAULTS, BEFORE);
  assert.match(readFileSync(INVENTORY, 'utf8'), /MACHINE_DEFAULTS/);
});
