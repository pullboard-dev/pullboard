/** @pullboard-test-input packages/state/src/logic/engine/behind-message.js */
/** A pure message names the device and seat that run an old engine, their release, the release needed and pullboard update [H16,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { behindMessage } from '../../../src/logic/engine/behind-message.js';

const releases = [{ engine: 1, release: '0.9.2' }, { engine: 100, release: '0.9.3' }, { engine: 200, release: '0.9.4' }];
const input = { device: 'studio-mac', seat: 'core-12', running: 150, needed: 230, releases };

test('clause 1: the message names the device and seat, the release running and needed, and pullboard update [H16]', () => {
  const message = behindMessage(input);
  for (const part of ['studio-mac', 'core-12', '0.9.3', '0.9.4', 'pullboard update']) assert.ok(message.includes(part), `${part} in: ${message}`);
});

test('clause 2: the message never prints a bare engine number [H16]', () => {
  const message = behindMessage(input);
  assert.doesNotMatch(message, /\b(150|230)\b/u);
  assert.doesNotMatch(message, /engine/iu);
});

test('clause 2: an engine with no known release is described in words, not by its number [H16]', () => {
  const message = behindMessage({ ...input, running: 0, needed: 230 });
  assert.match(message, /an older Pullboard/u);
  assert.doesNotMatch(message, /(^|\s)0(\s|$)/u);
  assert.match(message, /pullboard update/u);
});
