/** Exact legacy namespace and binding identity survive the lib move [C7,CD60]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as legacy0 from '../src/index.js';
import * as provider0 from '../apps/lib/src/core/index.js';
import * as legacy1 from '../src/native-board.js';
import * as provider1 from '../apps/lib/src/core/native-board.js';
import * as legacy2 from '../src/cli-hook-work.js';
import * as provider2 from '../apps/lib/src/shell/cli-hook-work.js';
import * as legacy3 from '../src/relay-checkpoint-worker.js';
import * as provider3 from '../apps/lib/src/shell/relay-checkpoint-worker.js';
import * as legacy4 from '../src/relay-sender-main.js';
import * as provider4 from '../apps/lib/src/shell/relay-sender-main.js';
import * as legacy5 from '../src/submit-handoff-worker.js';
import * as provider5 from '../apps/lib/src/shell/submit-handoff-worker.js';

const surfaces = [
  ['src/index.js', 'apps/lib/src/core/index.js', ['Refused', 'STANDARD_VERSION', 'blockedPaths', 'board', 'citedIds', 'commitMsgProblems', 'defaultConfig', 'frozenCriterion', 'laneNames', 'laneOf', 'lintSpec', 'listResources', 'loadConfig', 'loadDoctrine', 'main', 'outOfLane', 'parseSpec', 'secretsIn', 'standardDoctrine', 'takeResource'], legacy0, provider0],
  ['src/native-board.js', 'apps/lib/src/core/native-board.js', ['advanceItemSource', 'beginSentinelRun', 'board', 'closeBoard', 'decideSentinel', 'decideSpecRevisions', 'draftSpecRow', 'finishSentinelRun', 'flakeLedger', 'flakeQuarantines', 'gateRuns', 'landingWaiverFor', 'landingWaivers', 'nativeBoardPorts', 'openBoard', 'openBoardForRead', 'personProposals', 'personSigning', 'proposePersonMove', 'proposeSentinel', 'recordFlakeObservation', 'recordGateRun', 'recordPublishFinding', 'recordRowVerification', 'recordTrainLanding', 'setPersonSigning', 'waivedLandingProof'], legacy1, provider1],
  ['src/cli-hook-work.js', 'apps/lib/src/shell/cli-hook-work.js', ['HOOK_WORKER'], legacy2, provider2],
  ['src/relay-checkpoint-worker.js', 'apps/lib/src/shell/relay-checkpoint-worker.js', [], legacy3, provider3],
  ['src/relay-sender-main.js', 'apps/lib/src/shell/relay-sender-main.js', ['SENDER_WORKER', 'launchRelaySender'], legacy4, provider4],
  ['src/submit-handoff-worker.js', 'apps/lib/src/shell/submit-handoff-worker.js', ['runSubmitHandoffWorker', 'submitHandoffWorkerEntrypoint'], legacy5, provider5]
];

test('lib move preserves every legacy export name and exact provider binding [C7,CD60]', () => {
  for (const [old, moved, names, legacy, provider] of surfaces) {
    assert.deepEqual(Object.keys(legacy).sort(), names, old);
    assert.deepEqual(Object.keys(provider).sort(), names, moved);
    for (const name of names) assert.equal(legacy[name], provider[name], old + '#' + name);
  }
});

test('the package entry still re-exports the native board binding after the lib move [C7,CD60]', () => {
  assert.equal(legacy0.board, legacy1.board);
  assert.equal(typeof legacy0.main, 'function');
});
