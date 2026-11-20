/** The recorded conflict context check is exported by the state light door as the same function the front door exports [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRecordedConflictContext as fromFront } from '../../../index.js';
import { isRecordedConflictContext as fromLight } from '../../../light.js';
import { withRecordedConflictContext } from '../../../src/logic/recorded/context.js';

/** A board whose relay cursor reads as the given applied sequence. */
const boardAt = applied => ({ db: { prepare: () => ({ get: () => ({ meta_value: String(applied) }) }) } });

test('state.logic-recorded-context.light-door-exports-it: clause 1: [C7] the light door exports the very function the front door does; clause 2: it answers true inside a recorded reopen and false outside', () => {
  assert.equal(typeof fromLight, 'function', 'the light door exports isRecordedConflictContext');
  assert.equal(fromLight, fromFront, 'the same function, not a copy');
  const board = boardAt(4), item = { item_id: 7 }, receipt = { files: ['a.js'] };
  const move = { operation: 'reopen', args: [7, { agentId: 'core-1', computedConflict: receipt }] };
  assert.equal(fromLight(board, item, 'core-1', receipt), false, 'with no recorded conflict context it is false');
  const inside = withRecordedConflictContext(board, move, { sequence: 5, at: '2026-11-20T00:00:00.000Z' }, () => fromLight(board, item, 'core-1', receipt));
  assert.equal(inside, true, 'with a recorded conflict context at the next relay sequence it is true');
  assert.equal(fromLight(board, item, 'core-1', receipt), false, 'the context ends with its callback');
});
