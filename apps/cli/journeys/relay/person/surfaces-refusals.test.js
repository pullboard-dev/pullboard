/** Every refusal line the person can meet is free of codes, commands, tokens and relay terms; seats keep theirs [H23,C6,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personSurfaceLeaks } from '../../../tests/fixtures/person-surfaces.js';
import { seededPersonBoard } from '../../../tests/fixtures/person-surfaces.js';
import { refusalDocument } from '../../../index.js';
import { Refused } from '../../../../../packages/kernel/light.js';

test('every catalog refusal rendered for the person is plain [H23,C6,N26]', () => {
  const board = seededPersonBoard();
  assert.ok(board.length > 0);
  for (const { code } of board) {
    const { error } = refusalDocument(new Refused(code, 'refused for the fixture'), { caller: 'person' });
    assert.deepEqual(personSurfaceLeaks(`${error.message}\n${error.next}`), [], code);
    assert.ok(error.next, `${code} still tells the person what happens next`);
  }
});

test('a refusal message that carries a code, command or relay term is cleaned for the person [H23]', () => {
  const message = '[RELAY_UNAVAILABLE] the outbox is full\nrun pullboard relay on to resume';
  const { error } = refusalDocument(new Refused('RELAY_UNAVAILABLE', message), { caller: 'person' });
  assert.deepEqual(personSurfaceLeaks(`${error.message}\n${error.next}`), []);
});

test('seats and the coordinator keep their codes and commands [H23]', () => {
  const [{ code }] = seededPersonBoard().filter(entry => personSurfaceLeaks(refusalDocument(new Refused(entry.code, 'x'), { caller: 'person' }).error.next).length === 0 && personSurfaceLeaks(refusalDocument(new Refused(entry.code, 'x')).error.next).length > 0);
  const seat = refusalDocument(new Refused(code, 'refused for the fixture'), { caller: 'seat' });
  assert.equal(seat.error.code, code);
  assert.notEqual(personSurfaceLeaks(seat.error.next).length, 0, 'the agent-facing step keeps its command');
});
