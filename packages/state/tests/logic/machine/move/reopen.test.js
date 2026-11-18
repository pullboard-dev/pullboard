/** @pullboard-test-input source-cell packages/state */
/** The reland move is declared beside reopen and spread into the shared MOVES list [M1,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOVES as declared } from '../../../../src/logic/machine/move/reopen.js';
import { MOVES } from '../../../../src/logic/machine/declaration.js';

test('state.reland.declared-move: clause 1: reland is declared from open to verified by the coordinator with its seven guards and RELAND_NOT_ELIGIBLE [M1,C7]', () => {
  const move = declared.find(candidate => candidate.verb === 'reland');
  assert.ok(move, 'reopen.js declares reland');
  assert.deepEqual(move.from, ['open']);
  assert.equal(move.to, 'verified');
  assert.deepEqual(move.by, ['coordinator']);
  assert.equal(move.refuse, 'RELAND_NOT_ELIGIBLE');
  assert.equal(move.guards.length, 7);
  for (const guard of ['coordinatorOnly', 'itemExists', 'atSubmittedCommit', 'notBuilder', 'criterionUnchanged', 'proofNoted']) assert.ok(move.guards.includes(guard), `reland carries ${guard}`);
});

test('state.reland.in-moves: clause 2: the shared MOVES list carries the reland declaration exactly once [M1,C7]', () => {
  assert.equal(MOVES.filter(move => move.verb === 'reland').length, 1);
  assert.equal(MOVES.find(move => move.verb === 'reland'), declared.find(move => move.verb === 'reland'));
});
