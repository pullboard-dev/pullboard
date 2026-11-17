/** @pullboard-test-input source-cell seats */
/** itemTierPin reads an item's tier pin from the last tier-pin note fact [C7,#2178,#9840]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemTierPin } from '../../index.js';

const note = (text, kind = 'note') => ({ type: 'fact', kind, text });
const move = { type: 'move', kind: 'claim', detail: {} };

test('seats.tier-pin.last-note-wins: clause 1: itemTierPin returns the tier named by the last tier-pin note, and null when there is none [C7,#9840]', () => {
  assert.equal(itemTierPin([move, note('tier-pin: standard'), note('remember the milk')]), 'standard');
  assert.equal(itemTierPin([move, note('about tier-pin: standard'), note('tier-pin: standard extra'), note('tier-pin: standard', 'decision')]), null);
  assert.equal(itemTierPin([]), null);
  assert.equal(itemTierPin([move]), null);
});

test('seats.tier-pin.replace-and-clear: clause 2: a later tier-pin replaces an earlier pin and an empty tier-pin clears it [C7,#9840]', () => {
  assert.equal(itemTierPin([note('tier-pin: routine'), note('tier-pin: escalation')]), 'escalation');
  assert.equal(itemTierPin([note('tier-pin: routine'), note('tier-pin:')]), null);
  assert.equal(itemTierPin([note('tier-pin: routine'), note('tier-pin:'), note('tier-pin: standard')]), 'standard');
});
