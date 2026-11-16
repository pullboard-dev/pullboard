/** The seat.checkpoints setting and the five-part checkpoint fact it will switch on [C7,#8548]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../../../packages/config/index.js';
import { describeSetting } from '../../../../packages/config/src/io/settings/descriptions.js';
import {
  CHECKPOINT_PARTS,
  buildCheckpoint,
} from '../../../../packages/seats/index.js';

test('clause 1: seat.checkpoints exists with a description and defaults to off [C7,#8548]', () => {
  assert.equal(configFromSource('{}').seat?.checkpoints ?? false, false, 'a project that never sets it has it off');
  assert.equal(configFromSource('{"seat":{"checkpoints":true}}').seat.checkpoints, true, 'a project may turn it on');
  assert.match(describeSetting('seat.checkpoints').description, /checkpoint/, 'the setting has a description');
});

test('clause 2: the checkpoint fact builder returns the five parts [C7,#8548]', () => {
  assert.deepEqual(CHECKPOINT_PARTS, ['done', 'left', 'decisions', 'evidence', 'tokens']);
  const fact = buildCheckpoint({ done: ['built it'], left: ['wire submit'], decisions: ['off by default'], evidence: ['run 7e09'], tokens: 1200 });
  assert.deepEqual(Object.keys(fact), CHECKPOINT_PARTS);
  assert.deepEqual(fact, { done: ['built it'], left: ['wire submit'], decisions: ['off by default'], evidence: ['run 7e09'], tokens: 1200 });
  assert.deepEqual(buildCheckpoint(), { done: [], left: [], decisions: [], evidence: [], tokens: null }, 'an unknown part is empty, never absent');
});
