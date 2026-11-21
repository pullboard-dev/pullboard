/** The gate heavy door carries every name the gate index exports, so importers can leave the index one cell at a time [C7]. */
/** @pullboard-world-pin: clause 1 reads heavy.js source to prove it does not import the file dispatch or derived registries modules. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as heavy from '../heavy.js';
import * as index from '../index.js';
import * as light from '../light.js';

/** The index names status still reads from the index itself. */
const STAYS = new Set(['diskStores', 'gateControlFindings', 'performanceCores', 'retainedReceipts']);

/** The names whose index modules reach apps/cli: they stay off heavy.js until a later slice gives them their own door. The eight after the first 25 come from the file dispatch module and the next from the derived registries module, which heavy.js must not import; the last comes from the test cells module, which reaches apps/cli. */
const CLI_REACH = new Set([
  'runMainAudits', 'mainAuditJobs', 'routeAuditFailures', 'closeAuditedMainReds', 'withAuditedMain', 'testActionKeys', 'testResultStore',
  'reusableResult', 'suiteProven', 'planTestActions', 'preQueueReuse', 'reuseReceipt', 'RECORD_ONLY_PREFIX', 'TEST_REUSE_RECORD',
  'settleTestActions', 'recordTestAction', 'LEDGER_HITS_ENV', 'TEST_ACTIONS_ENV', 'TEST_STAGE_ENV', 'prepareTestResultExchange',
  'runFullSuite', 'testFiles', 'runTestFiles', 'inCleanCheckout', 'uncommittedNotice',
  'dispatchTestFiles', 'reportDispatchedTests', 'nativeFileArguments', 'testFileOptions', 'optionTakesValue', 'knownNodeOption',
  'legacyFileMode', 'legacyNativeFileRun', 'deriveTestRegistries', 'TEST_CELL_LISTING',
]);

test('gate.heavy.exports-index-heavy-names: clause 1: every index export except the light door names, four status names and the 35 apps/cli-reaching names is also exported by heavy.js as the same binding [C7]', () => {
  const names = Object.keys(index).filter(name => !(name in light) && !STAYS.has(name) && !CLI_REACH.has(name));
  assert.ok(names.length > 400, 'the index still exports its heavy names');
  const missing = names.filter(name => !(name in heavy));
  assert.deepEqual(missing, [], 'heavy.js exports every index heavy name');
  const other = names.filter(name => heavy[name] !== index[name]);
  assert.deepEqual(other, [], 'each heavy name is the index binding');
  const source = fs.readFileSync(new URL('../heavy.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('src/io/test/file/dispatch.js'), 'heavy.js does not import the file dispatch module');
  assert.ok(!source.includes('src/io/test/derived.js'), 'heavy.js does not import the derived registries module');
});
