/** An inbox entry stays until an action its kind allows is recorded, with inbox.keepUntilActed on [C7,#8519,#1886]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../../../packages/config/index.js';
import { entryBoard } from '../../tests/fixtures/inbox/entries.js';

test('clause 1: an inbox entry stays listed after it is read until it is archived [C7,#8519]', t => {
  const { shout, read, entries, act } = entryBoard(t);
  const id = shout('question', 'which file holds the lease rule?');
  assert.equal(read().length, 1, 'the first read delivers the shout');
  assert.equal(read().length, 0, 'the shout is read, so a plain inbox drops it');
  assert.deepEqual(entries().map(entry => entry.id), [id], 'the entry is still waiting for an action');
  act(id, 'archive');
  assert.deepEqual(entries(), [], 'archiving settles it');
});

test('clause 2: a shout kind refuses an action it does not allow and the entry stays [C7,#8519]', t => {
  const { shout, entries, act } = entryBoard(t);
  const id = shout('blocker', 'the gate is red on main');
  assert.throws(() => act(id, 'archive'), error => {
    assert.equal(error.code, 'ENTRY_ACTION_NOT_ALLOWED');
    assert.match(error.message, new RegExp(`entry #${id} is a blocker shout, which does not allow archive`, 'u'));
    assert.match(error.next, /answer, act, escalate/u, 'names what does settle it');
    return true;
  });
  assert.throws(() => act(id, 'ignore'), error => error.code === 'ENTRY_ACTION');
  assert.deepEqual(entries().map(entry => entry.id), [id], 'the refused action recorded nothing');
  act(id, 'act');
  assert.deepEqual(entries(), []);
});

test('clause 2: the setting is off by default [C7,#8519]', () => {
  assert.equal(configFromSource('{}').inbox.keepUntilActed, undefined, 'a project that never sets it has it off');
  assert.equal(configFromSource('{"inbox":{"keepUntilActed":true}}').inbox.keepUntilActed, true);
});
