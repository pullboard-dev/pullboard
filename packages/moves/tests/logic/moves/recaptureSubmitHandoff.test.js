/** The recaptureSubmitHandoff move descriptor is routed at the recapture engine and acts as its sender [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECAPTURE_SUBMIT_HANDOFF_ENGINE } from '../../../../state/light.js';
import { MOVE_REGISTRY } from '../../../index.js';

test('moves.logic-recapture-handoff.descriptor-routes-at-the-recapture-engine: clause 1: the recaptureSubmitHandoff descriptor has operation recaptureSubmitHandoff and minimumEngine RECAPTURE_SUBMIT_HANDOFF_ENGINE [C7,H16]', () => {
  const move = MOVE_REGISTRY.recaptureSubmitHandoff;
  assert.ok(move, 'the registry finds the descriptor');
  assert.equal(move.operation, 'recaptureSubmitHandoff');
  assert.equal(move.engine, RECAPTURE_SUBMIT_HANDOFF_ENGINE);
  assert.equal(move.minimumEngine(), RECAPTURE_SUBMIT_HANDOFF_ENGINE);
  assert.equal(move.itemIdFirstArgument, true);
  assert.deepEqual(Object.keys(move.nextSteps).sort(), ['BAD_SUBMIT_HANDOFF', 'SUBMIT_HANDOFF_CHANGED']);
});

test('moves.logic-recapture-handoff.actor-is-the-sender: clause 2: the actor is the sender in args[1].agentId, as for queueSubmitHandoff [C7,H16]', () => {
  const move = MOVE_REGISTRY.recaptureSubmitHandoff;
  assert.equal(move.actor({ args: [7, { agentId: 'core-1' }] }), 'core-1');
  assert.equal(move.actor({ args: [7, {}] }), null);
  assert.equal(move.actor({ args: [7] }), MOVE_REGISTRY.queueSubmitHandoff.actor({ args: [7] }));
});
