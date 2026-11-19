/** @pullboard-test-input source-cell packages/state */
/** recaptureSubmitHandoff shares queueSubmitHandoff's sealing step, so a recapture's captured main is sealed before the move is built [C7,#9818]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareEngineMove } from '../../../../src/io/engine.js';

/** A board whose seal port records its call and whose store has the recapture writer (prepareEngineMove refuses NO_STORE_WRITER without one); the move table's engine floor is below this engine so the move is built. */
function boardWith(seal) {
  return { enginePorts: { store: { recaptureSubmitHandoff() {} }, registry: {}, operations: ['recaptureSubmitHandoff'], minimumOperationEngine: () => 1, sealSubmitHandoffQueue: seal } };
}

test('state.io-engine-move-handoff.recapture-seals-its-captured-main: clause 1: prepareEngineMove seals a recapture\'s options through ports.sealSubmitHandoffQueue, so the prepared move\'s args[1] is the sealed value [C7,#9818]', () => {
  const calls = [];
  const board = boardWith((given, item, options) => { calls.push({ given, item, options }); return { ...options, main: 'sealed-main' }; });
  const move = prepareEngineMove(board, 'recaptureSubmitHandoff', [9818, { main: 'caller-main' }], { id: 'move-1' });
  assert.equal(calls.length, 1, 'the seal port ran once');
  assert.equal(calls[0].given, board);
  assert.equal(calls[0].item, 9818);
  assert.equal(move.operation, 'recaptureSubmitHandoff');
  assert.deepEqual(move.args[1], { main: 'sealed-main' });
});

test('state.io-engine-move-handoff.recapture-refuses-a-changed-source: clause 2: a SUBMIT_HANDOFF_CHANGED refusal from the seal port stops prepareEngineMove with SUBMIT_HANDOFF_CHANGED and builds no move [C7,#9818]', () => {
  const board = boardWith(() => { throw Object.assign(new Error('[SUBMIT_HANDOFF_CHANGED] the job source changed'), { code: 'SUBMIT_HANDOFF_CHANGED' }); });
  let move = null;
  assert.throws(() => { move = prepareEngineMove(board, 'recaptureSubmitHandoff', [9818, { main: 'caller-main' }], { id: 'move-2' }); }, (error) => error.code === 'SUBMIT_HANDOFF_CHANGED');
  assert.equal(move, null, 'no move was built');
});
