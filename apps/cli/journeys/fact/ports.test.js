/** Native outbox authority ports retain the original computed-return and actor guards [H16,V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  openBoard,
  nativeBoardPorts,
} from '../../../lib/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { transport } from '../../../../packages/outbox/index.js';
import { runRelaySender } from '../../../../packages/outbox/index.js';
import {
  intakeFixture,
  advanceOutsideFixture,
  fixtureJSON,
} from '../../tests/fixtures/intake.js';

test('computed relay transport validates through the native board before opening actor transport [H16,V4]', () => {
  const board = openBoard(':memory:');
  try {
    let opened = false;
    const move = { operation: 'reopen', args: [1, { agentId: 'coordinator', computedConflict: {} }] };
    assert.throws(() => transport('private-fixture', move,
      (root, pending) => {
        assert.equal(root, 'private-fixture');
        board.enginePorts.requirePreparedComputedConflict(board, pending.args[0], pending.args[1].agentId, pending.args[1].computedConflict);
      }, () => { opened = true; }), { code: 'COORDINATOR_ONLY' });
    assert.equal(opened, false, 'invalid native computed evidence cannot open actor transport');
  } finally { closeBoard(board); }
});

test('ordinary relay transport does not invent a computed-return validation [H16]', () => {
  const value = {};
  let validations = 0;
  assert.equal(transport('private-fixture', { operation: 'shout', args: [] },
    () => { validations++; }, () => value), value);
  assert.equal(validations, 0);
});

test('raw native boards refuse a missing credential actor port instead of falling back [H16,C7]', () => {
  const original = nativeBoardPorts();
  const ports = { ...original, enginePorts: { ...original.enginePorts, credentialActor: undefined } };
  assert.throws(() => openBoard(':memory:', undefined, { ports }), { code: 'NO_POLICY' });
});

test('the lower sender refuses to start without its explicit board service [H21,C7]', async () => {
  await assert.rejects(runRelaySender({}), { name: 'TypeError', message: 'runRelaySender requires the board service' });
});

test('outside intake protects both actual sender authority homes and its historical path [H16,B26]', t => {
  const box = intakeFixture(t);
  const paths = ['src/relay-sender.js', 'packages/state/src/logic/relay/sender.js', 'src/board-engine-ports.js', 'packages/store/src/io/board/ports.js'];
  for (const path of paths) advanceOutsideFixture(box, path, 'export const authorityFixture = true;\n');
  advanceOutsideFixture(box, 'lib/ordinary.js', 'export const ordinaryFixture = true;\n');
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url,
    '--criterion', 'the private contribution preserves its declared behavior', '--check', 'node --test test/contribution.test.js');
  for (const path of paths) assert.ok(filed.item.outside.sensitivity.some(reason =>
    reason.path === path && reason.rule === 'declared-sensitive-path'), path);
  assert.equal(filed.item.outside.sensitivity.some(reason => reason.path === 'lib/ordinary.js'), false);
});
