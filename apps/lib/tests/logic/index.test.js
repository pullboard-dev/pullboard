/** The lib front door re-exports every provider name with exact binding identity [C7,CD60]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as front from '../../index.js';
import * as provider0 from '../../src/logic/index.js';
import * as provider1 from '../../src/logic/native.js';

const surfaces = [
  ['src/index.js', 'apps/lib/src/core/index.js', ['Refused', 'STANDARD_VERSION', 'blockedPaths', 'board', 'citedIds', 'commitMsgProblems', 'defaultConfig', 'frozenCriterion', 'laneNames', 'laneOf', 'lintSpec', 'listResources', 'loadConfig', 'loadDoctrine', 'outOfLane', 'parseSpec', 'secretsIn', 'standardDoctrine', 'takeResource'], provider0],
  ['apps/lib/index.js', 'apps/lib/src/core/native-board.js', ['advanceItemSource', 'beginSentinelRun', 'board', 'closeBoard', 'decideSentinel', 'decideSpecRevisions', 'draftSpecRow', 'finishSentinelRun', 'flakeLedger', 'flakeQuarantines', 'gateRuns', 'landingWaiverFor', 'landingWaivers', 'nativeBoardPorts', 'openBoard', 'openBoardForRead', 'personProposals', 'personSigning', 'proposePersonMove', 'proposeSentinel', 'recordFlakeObservation', 'recordGateRun', 'recordPublishFinding', 'recordRowVerification', 'recordTrainLanding', 'setPersonSigning', 'waivedLandingProof'], provider1]
];

test('the lib front door binds every provider export by identity [C7,CD60]', () => {
  for (const [old, moved, names, provider] of surfaces) {
    assert.deepEqual(Object.keys(provider).sort(), names, moved);
    for (const name of names) assert.equal(front[name], provider[name], old + '#' + name);
  }
});

test('the package entry re-exports the native board binding [C7,CD60]', () => {
  assert.equal(front.board, provider1.board);
});
