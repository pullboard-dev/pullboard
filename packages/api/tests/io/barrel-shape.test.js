/** @pullboard-test-input source-cell api */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as api from '../../index.js';

const FILE = new URL('../../index.js', import.meta.url);

/** Every name the api barrel exported before it was reflowed [C7]. */
const BEFORE = [
  'CHECK_BASELINE_KIND',
  'JOB_MAX_ATTEMPTS',
  'LANDING_JOB_KIND',
  'LAND_PAYLOAD_SHAPE',
  'PUSH_ALIVE_MS',
  'SHARD_JOB_KIND',
  'WHOLE_STATE_DELTA_FIELDS',
  'apiBoardListing',
  'apiBoards',
  'apiJson',
  'apiRefusal',
  'apiStatus',
  'applyGateReceipt',
  'applyInbox',
  'applyJobReceipt',
  'applyLandingReceipt',
  'applyShardReceipt',
  'applyStateDelta',
  'applyTestReceipt',
  'boardJobQueueCall',
  'boardQueueMode',
  'claimJob',
  'codeAt',
  'combinedReceipt',
  'compareGateWithMain',
  'createApiHandler',
  'createLocalApiHandler',
  'createStateSnapshots',
  'endGateHop',
  'endJobs',
  'endStaleGateJobs',
  'executeMove',
  'failingParts',
  'gateClaimHop',
  'gateLedgerHits',
  'heldShards',
  'hopTableOver',
  'jobArtifacts',
  'jobQueueCall',
  'jobRequest',
  'jobViews',
  'keepJobsAlive',
  'latestGateJob',
  'mainRedReceiptId',
  'mainTestCommand',
  'offerCheckBaseline',
  'offerJob',
  'offerLandShards',
  'offerLandingJob',
  'offerReleaseShards',
  'offeredGate',
  'offeredRequest',
  'offeredStep',
  'openJob',
  'openLandingJob',
  'poolHandlers',
  'postArtifact',
  'postReceipt',
  'postedReceipt',
  'projectItemState',
  'provideBaselineRecorder',
  'provideCompanionInheritance',
  'provideComparisonStart',
  'provideGateHopTable',
  'provideJobTable',
  'provideLandingStart',
  'provideMainComparison',
  'provideMainRedNotes',
  'provideMainTestRecorder',
  'provideRefusalTrials',
  'provideTimingExcuse',
  'pulledGateReds',
  'queueDraining',
  'queueFor',
  'queueOffer',
  'readApiBody',
  'readLandShardReceipts',
  'recordPhaseReceipts',
  'releaseJob',
  'releaseParticipationShards',
  'renewJob',
  'reofferLandingJob',
  'reportRunaway',
  'runnerCommitPort',
  'serveApi',
  'shardClaimCap',
  'shardJobs',
  'shardedResult',
  'withLandingPermit',
  'withdrawLandShards',
];

test('api.barrel-shape.barrel-line-passes-120-chars: clause 1: no barrel line passes 120 chars and multi-name exports list one name per line, sorted [C7]', () => {
  const text = readFileSync(FILE, 'utf8');
  for (const line of text.split('\n')) assert.ok(line.length <= 120, `line too long: ${line.slice(0, 60)}`);
  for (const match of text.matchAll(/export \{([^}]*)\} from/g)) {
    const names = match[1].split('\n').map((line) => line.trim()).filter(Boolean);
    if (names.length === 1 && !names[0].endsWith(',')) continue;
    assert.ok(names.every((name) => /^[A-Za-z0-9_$]+,$/.test(name)), `not one per line: ${match[1].slice(0, 60)}`);
    const plain = names.map((name) => name.slice(0, -1));
    assert.deepEqual(plain, [...plain].sort());
  }
});

test('api.barrel-shape.barrel-exports-exactly-names-did: clause 2: the barrel exports exactly the names it did before the reflow [C7]', () => {
  assert.deepEqual(Object.keys(api).sort(), BEFORE);
});
