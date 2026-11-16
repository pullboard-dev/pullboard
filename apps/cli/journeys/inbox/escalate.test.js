/** An unacted inbox entry escalates to the coordinator, then the person, after the stated interval [C7,#8520,#1886]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../../../packages/config/index.js';
import { entryBoard } from '../../tests/fixtures/inbox/entries.js';

const toPerson = board => board.db.prepare("SELECT shout_text AS text FROM shout WHERE shout_to='person'").all();
const toCoordinator = board => board.db.prepare("SELECT shout_text AS text FROM shout WHERE shout_to='coordinator' AND shout_from='inbox'").all();

test('clause 1: an unacted entry escalates after the stated interval, to the coordinator and then the person [C7,#8520]', t => {
  const { board, shout, escalate, entries, act } = entryBoard(t);
  const id = shout('question', 'which file holds the lease rule?');
  assert.deepEqual(escalate(30, 29), [], 'inside the interval nothing escalates');
  assert.deepEqual(escalate(30, 31).map(step => [step.id, step.to, step.level]), [[id, 'coordinator', 1]]);
  assert.match(toCoordinator(board)[0].text, new RegExp(`inbox entry #${id} has waited 3\\d minutes`, 'u'));
  assert.deepEqual(escalate(30, 32), [], 'the same interval does not escalate twice');
  assert.deepEqual(escalate(30, 61).map(step => [step.id, step.to, step.level]), [[id, 'person', 2]]);
  assert.equal(toPerson(board).length, 1);
  assert.deepEqual(escalate(30, 500), [], 'the person is the last stop');
  assert.equal(entries()[0].level, 2, 'the entry still waits, now escalated twice');
  act(id, 'archive');
  assert.deepEqual(escalate(30, 900), [], 'a settled entry never escalates');
});

test('clause 1: an entry settled inside the interval never escalates, and the interval is off by default [C7,#8520]', t => {
  const { board, shout, escalate, act } = entryBoard(t);
  act(shout('question', 'which file?'), 'archive');
  assert.deepEqual(escalate(30, 120), []);
  assert.deepEqual(toCoordinator(board), []);
  assert.equal(configFromSource('{}').inbox.escalateAfterMinutes, undefined);
  assert.equal(configFromSource('{"inbox":{"escalateAfterMinutes":45}}').inbox.escalateAfterMinutes, 45);
});
