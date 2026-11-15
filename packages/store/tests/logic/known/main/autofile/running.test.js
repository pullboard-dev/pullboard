/** Known-main proof links retain helper execution identity without rewriting older rows [V4,B3,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownersOf } from '../../../../../index.js';
import { linkKnownMainReworks } from '../../../../../index.js';
import { requireKnownMainReworks } from '../../../../../index.js';
import { KNOWN_MAIN_OWNER_PATTERN_ENGINE } from '../../../../../../state/light.js';
import { KNOWN_MAIN_RUNNING_FILE_ENGINE } from '../../../../../../state/light.js';
import * as store from '../../../../../index.js';
import { fixtureBoard } from '../../../../../../board/tests/fixtures/board.js';
import { prepareEngineMove } from '../../../../../../state/index.js';
import { applyEngineMove } from '../../../../../../state/index.js';
import { submissionProof } from '../../../../../../state/index.js';
import { exportBoard } from '../../../../../index.js';
import { importBoard } from '../../../../../index.js';

const failure = { file: 'apps/cli/tests/fixtures/move/registry/cases.js', ran: 'apps/cli/journeys/move/registry.test.js',
  name: 'the helper-defined move case [C7]', signature: 'a'.repeat(64) };

/** Build the exact frozen repair path used by owner matching. */
function repair(id, file) {
  return { item_id: id, item_status: 'open', item_title: 'Main red: helper case',
    item_frozen: JSON.stringify({ check: `node apps/cli/src/io/run/tests.js ${file}`, criterion: 'Repair the helper-defined move case.' }) };
}

test('a running-file-only owner matches a helper-defined failure on the new engine [V4,B3,H16]', () => {
  const owner = repair(7, failure.ran);
  assert.deepEqual(ownersOf(failure, [owner]).map(row => row.item_id), [], 'old engine matching keeps helper-file-only identity');
  assert.deepEqual(ownersOf(failure, [owner], undefined, true, true).map(row => row.item_id), [7]);
  const known = { main: 'b'.repeat(40), failures: [{ ...failure, item: 7 }] };
  const linked = linkKnownMainReworks(known, [owner], undefined, true, true);
  assert.doesNotThrow(() => requireKnownMainReworks(linked, [owner], undefined, true, true));
  assert.equal(linkKnownMainReworks(known, [owner]), null, 'older owner matching does not reinterpret a helper path');
  const proof = { version: 1, files: [failure.ran], full: false, deferred: false, reason: '', knownMainFailures: known };
  assert.deepEqual(submissionProof(proof, KNOWN_MAIN_RUNNING_FILE_ENGINE).knownMainFailures, known);
  assert.throws(() => submissionProof(proof, KNOWN_MAIN_OWNER_PATTERN_ENGINE), { code: 'SUBMISSION_PROOF' });
});

test('old known-main rows preserve their bytes under the earlier engine [V4,B3,H16]', () => {
  const owner = repair(8, failure.file);
  const oldFailure = { file: failure.file, name: failure.name, signature: failure.signature, item: owner.item_id };
  const oldKnown = { main: 'c'.repeat(40), failures: [oldFailure] };
  const input = { version: 1, files: [failure.file], full: false, deferred: false, reason: '', knownMainFailures: oldKnown };
  assert.deepEqual(submissionProof(input, KNOWN_MAIN_OWNER_PATTERN_ENGINE).knownMainFailures, oldKnown);
  const linked = linkKnownMainReworks(oldKnown, [owner], undefined, true, false);
  assert.doesNotThrow(() => requireKnownMainReworks(linked, [owner], undefined, true, false));
});

test('the higher-engine submit replay records the running path and rejects old-engine downgrade [V4,B3,H16]', t => {
  const at = '2026-11-04T00:00:00.000Z';
  const board = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  store.register(board, { lane: 'coordinator', path: '/fixture/coordinator' });
  const agentId = store.register(board, { lane: 'web', path: '/fixture/web' });
  const item = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Helper failure submit' });
  const owner = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Main red: helper case',
    check: `node apps/cli/src/io/run/tests.js ${failure.ran}` });
  store.claim(board, item, { agentId, lane: 'web', leaseMs: 3600000,
    freeze: () => ({ text: '{"rows":[]}', digest: 'f'.repeat(64) }) });
  const known = { main: 'd'.repeat(40), failures: [{ ...failure, item: owner }] };
  const options = { agentId, commit: 'e'.repeat(40), tree: 'f'.repeat(40), submissionProof: {
    version: 1, files: [failure.ran], full: false, deferred: true, reason: 'fixture replay', knownMainFailures: known } };
  const move = prepareEngineMove(board, 'submit', [item, options], { id: 'running-file-known-main-submit' });
  assert.ok(move.engine >= KNOWN_MAIN_RUNNING_FILE_ENGINE);
  const replica = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  importBoard(replica, exportBoard(board));
  const before = exportBoard(replica);
  assert.throws(() => applyEngineMove(replica, { ...move, engine: KNOWN_MAIN_OWNER_PATTERN_ENGINE }, { sequence: 1, at }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(replica), before, 'the old engine leaves history unchanged when it cannot interpret ran');
  const applied = applyEngineMove(board, move, { sequence: 1, at });
  assert.equal(applied.error, undefined, JSON.stringify(applied));
  const event = store.events(board, { itemId: item }).find(row => row.event_kind === 'submit');
  assert.deepEqual(JSON.parse(event.event_detail).submissionProof.knownMainFailures, known,
    'higher-engine replay keeps helper and running-file identity in the canonical receipt');
  assert.deepEqual(applyEngineMove(replica, move, { sequence: 1, at }), applied,
    'the replica derives the same submitted state from the ordered higher-engine move');
});
