/** @pullboard-test-input source-cell packages/items */
/** The Needs you allowance line shows once at 20 percent left or less, and the 5-percent line replaces it at 5 or less [N2,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { allowanceWords } from '../../index.js';
import { personBlockWords } from '../../index.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const RESET = '2026-11-18T15:30:00.000Z';

test('items.blocks.allowance-20-percent-line: clause 1: an allowance of 15 percent left returns one 20-percent line naming the seat, the percent left and the reset time [N2,C7]', () => {
  const lines = allowanceWords({ known: true, percentLeft: 15, windowMinutes: 300, resetsAt: RESET }, 'core-7', NOW);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].code, 'ALLOWANCE_WARN');
  assert.equal(lines[0].audience, 'person');
  assert.match(lines[0].reason, /core-7/u);
  assert.match(lines[0].reason, /15 percent/u);
  assert.match(lines[0].reason, /20-percent/u);
  assert.match(lines[0].reason, new RegExp(RESET, 'u'));
});

test('items.blocks.allowance-5-percent-line: clause 2: an allowance of 4 percent left returns one 5-percent line and not the 20-percent line, and 40 percent or an unknown allowance returns none [N2,C7]', () => {
  const lines = allowanceWords({ known: true, percentLeft: 4, resetsAt: RESET }, 'core-7', NOW);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].code, 'ALLOWANCE_LOW');
  assert.match(lines[0].reason, /5-percent/u);
  assert.doesNotMatch(lines[0].reason, /20-percent/u);
  assert.deepEqual(allowanceWords({ known: true, percentLeft: 40, resetsAt: RESET }, 'core-7', NOW), []);
  assert.deepEqual(allowanceWords({ known: false }, 'core-7', NOW), []);
  assert.deepEqual(allowanceWords(undefined, 'core-7', NOW), []);
});

test('items.blocks.needs-you-carries-allowance: clause 3: the Needs you list composer shows the allowance line, and no line without an allowance [N2,C7]', t => {
  const { root: commonDir } = privateFixtureFiles('pullboard-allowance-words-');
  t.after(() => rmSync(commonDir, { recursive: true, force: true }));
  const words = personBlockWords(commonDir, NOW, undefined, { allowance: { known: true, percentLeft: 15, resetsAt: RESET }, seat: 'core-7' });
  assert.deepEqual(words.map(line => line.code), ['ALLOWANCE_WARN']);
  assert.deepEqual(personBlockWords(commonDir, NOW), []);
});
