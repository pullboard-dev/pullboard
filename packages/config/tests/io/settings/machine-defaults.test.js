/** @pullboard-test-input source-cell config */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MACHINE_DEFAULTS } from '../../../src/io/settings/machine-defaults.js';
import { SETTING_DESCRIPTIONS } from '../../../src/io/settings/descriptions.js';

const FILE = new URL('../../../src/io/settings/machine-defaults.js', import.meta.url);
const INVENTORY = new URL('../../../src/io/settings/inventory.js', import.meta.url);

/** The key/default list as it stood before the move [O5,O6]. */
const BEFORE = {
  'add.warnUnnamedTest': false,
  'api.codeStampCache': false,
  'board.archiveEvents': false,
  'board.crossProcessWrites': false,
  'board.hotState': false,
  'browserSlots': 1,
  'budget.dailyUsd': null,
  'budget.totalUsd': null,
  'canary.directPush': false,
  'census.balanceByTime': false,
  'census.jobMinutes': null,
  'census.jobsPerRunner': null,
  'census.jobsPerRunnerQuiet': null,
  'census.recordFileTimes': false,
  'census.rerunNonGreen': false,
  'census.rerunOnSettle': false,
  'census.selfTune': false,
  'census.soloFileSeconds': null,
  'claim.keepWhileRunning': false,
  'claim.refuseOffMainHead': false,
  'docs.regenerateOnCommit': false,
  'engine.nameBehindDevice': false,
  'flakes.rereadRatchet': false,
  'freeze.refuseEmptyBar': false,
  'gate.adapterLintClock': false,
  'gate.adapterLintFs': false,
  'gate.adapterLintTimers': false,
  'gate.boardOpensCheck': false,
  'gate.browserByLaunch': false,
  'gate.browserFreeChecks': false,
  'gate.componentTier': false,
  'gate.contractAudit': false,
  'gate.contractWeakening': false,
  'gate.diskFloorMB': 10240,
  'gate.endStaleJobs': false,
  'gate.excuseMainTimingReds': false,
  'gate.fencedHop': true,
  'gate.handoffWorkers': null,
  'gate.idiomSpread': false,
  'gate.jobReserve': null,
  'gate.junitReport': null,
  'gate.literalPins': false,
  'gate.loadAwareDispatch': true,
  'gate.localLoadShare': 1,
  'gate.localRunner': true,
  'gate.mainCaseFilter': false,
  'gate.mainComparison': 'on-red',
  'gate.measuredSlots': false,
  'gate.memoryFloorMB': null,
  'gate.namedImportSelection': false,
  'gate.overlapStaticProof': false,
  'gate.postLandSuite': false,
  'gate.pulledProfilePaths': false,
  'gate.queue.agingMinutes': 30,
  'gate.queue.currentReleaseFirst': false,
  'gate.queue.reviewsFirst': false,
  'gate.recaptureHandoff': false,
  'gate.redFactLocation': false,
  'gate.refuseMissingCheckFile': false,
  'gate.refuseTempWorktree': false,
  'gate.reofferInfraEnd': false,
  'gate.requireRunnerAttribution': false,
  'gate.runnerBusyCeiling': 90,
  'gate.runnerDispatch': 'pull',
  'gate.runnerWaitMs': 300000,
  'gate.runnersFirst': false,
  'gate.runnersOnly': false,
  'gate.sampleDiskIo': false,
  'gate.settleOnMainReceipt': false,
  'gate.shortSlots': 0,
  'gate.staticLoadAdmission': false,
  'gate.staticMemo': false,
  'gate.staticSlots': 2,
  'gate.submitAuthorization': 'runner',
  'gate.tableReplay': false,
  'gate.testNice': false,
  'gate.timingRunner': 'auto',
  'gate.tripOverheadBudgetMs': 10000,
  'gate.viewTimerLayout': false,
  'gate.withdrawCancelsJob': false,
  'gateSlots': 2,
  'health.derivedState': false,
  'health.diskFloorGb': 0,
  'health.lapsedSweep': false,
  'health.sentinel': true,
  'holds.liftSettled': false,
  'holds.requireOwner': false,
  'inspection.clauses': false,
  'items.typedFields': false,
  'jobs.avoidRunners': false,
  'jobs.handBackUnrunnable': false,
  'landing.asyncFetch': false,
  'landing.byHand': false,
  'landing.junitFailures': false,
  'landing.junitSignatures': false,
  'landing.parallelGates': false,
  'landing.pools': [],
  'landing.reofferTrunkBusy': false,
  'landing.reuseContractResults': false,
  'landing.reuseGateReceipts': false,
  'landing.squash': false,
  'landing.stallStop': false,
  'landing.staticAffectedOnly': false,
  'landing.strictFullSuite': false,
  'list.thinRead': false,
  'machine.loadCeiling': null,
  'maintenance.retireIdleHours': 3,
  'maintenance.retireIdleSeats': false,
  'moves.live.claim': false,
  'moves.live.handoff': false,
  'moves.live.job': false,
  'moves.live.outbox': false,
  'moves.live.outcome': false,
  'moves.live.reclaim': false,
  'moves.live.reopen': false,
  'moves.live.submit': false,
  'moves.shadow': false,
  'next.adoptPreserved': false,
  'next.capBuilders': 0,
  'next.holdAboveLoad': false,
  'next.idleBlockers': false,
  'next.itemNotices': false,
  'next.lightShapedStrong': false,
  'next.readinessCache': false,
  'next.readinessCheck': false,
  'push.recordTiming': false,
  'push.rerunFailedShardOnce': false,
  'read.thinCommands': false,
  'relay.excludeByBoard': false,
  'relay.offerAtInit': true,
  'relay.pruneReceipts': false,
  'relay.push': false,
  'relay.queueOnFailure': false,
  'release.rerouteUntouched': false,
  'review.canonicalFamilies': false,
  'review.relaxRequiredFamily': false,
  'review.releaseReasons': false,
  'review.starveShout': false,
  'runner.packCache': false,
  'runnerRates': {},
  'runners': [],
  'runners.drainOnFetchFailure': false,
  'runners.fetchConcurrent': false,
  'runners.fetchFailFast': false,
  'runners.postedLineNamesCase': false,
  'runners.requiredToolchains': null,
  'runners.yieldWhilePruning': false,
  'scratch': null,
  'sentinels.recordWriteHolder': false,
  'serve.address': '127.0.0.1',
  'serve.port': 0,
  'serve.pullRoute': false,
  'spec.cascadeReject': false,
  'spec.commitOnApply': false,
  'stats.recordCoordinatorUsage': false,
  'status.showUsefulBuilders': false,
  'submit.clauseMarks': false,
  'submit.proofOnly': false,
  'submit.recoverFromJobRow': false,
  'test.inProcessHooks': false,
  'test.statusOutcomes': false,
  'tests.registryStrict': false,
  'tests.requireDeclaredInputs': false,
  'tests.requireJourneyPath': false,
  'tests.requireRegistered': false,
  'verify.hunkFreshness': false,
  'verify.rejectKeepsCheck': false,
  'view.background': true,
  'watch.quietReads': false,
};

test('config.io-settings-machine-defaults.clause-1-every-machine-default-key-sits: clause 1: every machine default key sits on its own line, in sorted order [O5]', () => {
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

/**
 * Problems with a defaults object against the BEFORE list: a BEFORE key that
 * is gone or changed, or a key outside BEFORE that does not default off.
 * Adding a setting never reddens main so long as it defaults false or null.
 */
function defaultsProblems(defaults) {
  const problems = [];
  for (const [key, value] of Object.entries(BEFORE)) {
    if (!(key in defaults)) problems.push(`${key} is gone`);
    else if (JSON.stringify(defaults[key]) !== JSON.stringify(value)) problems.push(`${key} changed`);
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (key in BEFORE) continue;
    if (value !== false && value !== null) problems.push(`${key} is new and not off`);
  }
  return problems;
}

test('config.io-settings-machine-defaults.clause-1-every-key-in-before-keeps-its: clause 1: every key in BEFORE keeps its value in MACHINE_DEFAULTS [O6]', () => {
  const kept = {};
  for (const key of Object.keys(BEFORE)) kept[key] = MACHINE_DEFAULTS[key];
  assert.deepEqual(kept, BEFORE);
  assert.match(readFileSync(INVENTORY, 'utf8'), /MACHINE_DEFAULTS/);
});

test('config.io-settings-machine-defaults.clause-2-every-key-outside-before: clause 2: every key outside BEFORE defaults to false or null [O6]', () => {
  const added = Object.entries(MACHINE_DEFAULTS).filter(([key]) => !(key in BEFORE));
  for (const [key, value] of added) {
    assert.ok(value === false || value === null, `${key} is new and must default off, got ${JSON.stringify(value)}`);
  }
  assert.deepEqual(defaultsProblems(MACHINE_DEFAULTS), []);
});

test('config.io-settings-machine-defaults.clause-3-removing-a-before-key-or: clause 3: removing a BEFORE key or changing its value fails the check [O6]', () => {
  const gone = { ...MACHINE_DEFAULTS };
  delete gone['gate.fencedHop'];
  assert.deepEqual(defaultsProblems(gone), ['gate.fencedHop is gone']);
  const flipped = { ...MACHINE_DEFAULTS, 'gate.fencedHop': false };
  assert.deepEqual(defaultsProblems(flipped), ['gate.fencedHop changed']);
  const loud = { ...MACHINE_DEFAULTS, 'brand.new': true };
  assert.deepEqual(defaultsProblems(loud), ['brand.new is new and not off']);
  assert.deepEqual(defaultsProblems({ ...MACHINE_DEFAULTS, 'brand.new': false }), []);
});

test('config.io-settings-machine-defaults.clause-1-gate-adapterlinttimers-is-in: clause 1: gate.adapterLintTimers is in the BEFORE list and defaults to false [C7]', () => {
  assert.equal(BEFORE['gate.adapterLintTimers'], false);
  assert.equal(MACHINE_DEFAULTS['gate.adapterLintTimers'], false);
});

test('config.io-settings-machine-defaults.clause-1-gate-idiomspread-is-in-the: clause 1: gate.idiomSpread is in the BEFORE list and defaults to false [C7]', () => {
  assert.equal(BEFORE['gate.idiomSpread'], false);
  assert.equal(MACHINE_DEFAULTS['gate.idiomSpread'], false);
});

test('config.io-settings-machine-defaults.clause-1-landing-asyncfetch-is-a-machine: clause 1: landing.asyncFetch is a machine setting, false by default, with a description [C7]', () => {
  assert.equal(MACHINE_DEFAULTS['landing.asyncFetch'], false);
  assert.ok(SETTING_DESCRIPTIONS['landing.asyncFetch']);
});

test('config.io-settings-machine-defaults.clause-1-next-lightshapedstrong-is-a: clause 1: next.lightShapedStrong is a machine setting, false by default, with a description [C7]', () => {
  assert.equal(MACHINE_DEFAULTS['next.lightShapedStrong'], false);
  assert.ok(SETTING_DESCRIPTIONS['next.lightShapedStrong']);
});

test('config.io-settings-machine-defaults.clause-1-gate-overlapstaticproof-is-a: clause 1: gate.overlapStaticProof is a machine setting, false by default, with a description [C7]', () => {
  assert.equal(MACHINE_DEFAULTS['gate.overlapStaticProof'], false);
  assert.ok(SETTING_DESCRIPTIONS['gate.overlapStaticProof']);
});

test('config.io-settings-machine-defaults.clause-1-review-relaxrequiredfamily-is-a: clause 1: review.relaxRequiredFamily is a machine setting, false by default, with a description [V1]', () => {
  assert.equal(MACHINE_DEFAULTS['review.relaxRequiredFamily'], false);
  assert.ok(SETTING_DESCRIPTIONS['review.relaxRequiredFamily']);
});

test('config.io-settings-machine-defaults.clause-1-runners-requiredtoolchains-is-a: clause 1: runners.requiredToolchains is a machine setting, blank by default, with a description [C7]', () => {
  assert.equal(MACHINE_DEFAULTS['runners.requiredToolchains'], null);
  assert.ok(SETTING_DESCRIPTIONS['runners.requiredToolchains']);
});

/** Read tests.requireDeclaredInputs through a private machine home holding the given settings. */
async function declaredInputsWith(settings) {
  const { privateFixtureFiles } = await import('../../../../gate/tests/fixtures/child.js');
  const { fixtureMachineSettings } = await import('../../../../gate/tests/fixtures/testkit.js');
  const { requireDeclaredInputsEnabled } = await import('../../../index.js');
  const { mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { root } = privateFixtureFiles('pullboard-declared-inputs-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return requireDeclaredInputsEnabled();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-machine-defaults.clause-1-tests-requiredeclaredinputs-is: clause 1: tests.requireDeclaredInputs is listed with a description and defaults to false [C7,#9799]', async () => {
  assert.equal(MACHINE_DEFAULTS['tests.requireDeclaredInputs'], false);
  assert.ok(SETTING_DESCRIPTIONS['tests.requireDeclaredInputs']);
  assert.equal(await declaredInputsWith({}), false);
});

test('config.io-settings-machine-defaults.clause-2-only-the-exact-value-true-turns: clause 2: only the exact value true turns tests.requireDeclaredInputs on [C7,#9799]', async () => {
  assert.equal(await declaredInputsWith({ tests: { requireDeclaredInputs: true } }), true);
  assert.equal(await declaredInputsWith({ tests: { requireDeclaredInputs: false } }), false);
});
