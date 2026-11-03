/** Exact legacy namespace and binding identity survive the lib move [C7,CD60]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as legacy0 from '../src/index.js';
import * as provider0 from '../apps/lib/src/core/index.js';
import * as legacy1 from '../src/native-board.js';
import * as provider1 from '../apps/lib/src/core/native-board.js';

const surfaces = [
  ['src/index.js', 'apps/lib/src/core/index.js', ['Refused', 'STANDARD_VERSION', 'blockedPaths', 'board', 'citedIds', 'commitMsgProblems', 'defaultConfig', 'frozenCriterion', 'laneNames', 'laneOf', 'lintSpec', 'listResources', 'loadConfig', 'loadDoctrine', 'main', 'outOfLane', 'parseSpec', 'secretsIn', 'standardDoctrine', 'takeResource'], legacy0, provider0],
  ['src/native-board.js', 'apps/lib/src/core/native-board.js', ['advanceItemSource', 'beginSentinelRun', 'board', 'closeBoard', 'decideSentinel', 'decideSpecRevisions', 'draftSpecRow', 'finishSentinelRun', 'flakeLedger', 'flakeQuarantines', 'gateRuns', 'landingWaiverFor', 'landingWaivers', 'nativeBoardPorts', 'openBoard', 'openBoardForRead', 'personProposals', 'personSigning', 'proposePersonMove', 'proposeSentinel', 'recordFlakeObservation', 'recordGateRun', 'recordPublishFinding', 'recordRowVerification', 'recordTrainLanding', 'setPersonSigning', 'waivedLandingProof'], legacy1, provider1]
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
