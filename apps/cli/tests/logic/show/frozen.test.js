/** show's frozen bar and test author lines come from one pure function, with the exact text show printed before [C7,#10766]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frozenLines } from '../../../src/logic/show/frozen.js';

const ITEM = { item_frozen_digest: 'e6a1b4e2623a1ba6267892204d8ed5a0' };
const FROZEN = {
  rows: [{ id: 'C7', text: 'CI runs the gate', gate: 'packages/gate/tests/ci.test.js' }, { id: 'P1', text: 'Work keeps its evidence' }],
  testHashes: { 'a/ruled.test.js': 'a'.repeat(64), 'a/plain.test.js': 'b'.repeat(64) },
};
const FACTS = {
  rulings: [{ path: 'a/ruled.test.js', factId: 'fact-1', hash: 'c'.repeat(64) }],
  authors: { 'a/authored.test.js': { seat: 'core-7', family: 'anthropic' } },
  reviewerFamilies: [],
  testFiles: ['a/authored.test.js', 'a/unauthored.test.js'],
  agentName: seat => `${seat} (model)`,
  readable: text => text,
};

test('cli.logic-show-frozen.frozen-lines-match-the-recorded-text: clause 1: frozenLines returns the frozen-at-claim lines with one ruled test hash and the author lines for one authored and one unauthored test exactly as show printed them [C7]', () => {
  assert.deepEqual(frozenLines(ITEM, FROZEN, FACTS), {
    frozen: [
      'frozen at claim (e6a1b4e2623a):',
      '  C7: CI runs the gate  | gate: packages/gate/tests/ci.test.js',
      '  P1: Work keeps its evidence',
      `  test a/ruled.test.js: sha256 ${'a'.repeat(64)}; person ruling fact-1 accepts cccccccccccc`,
      `  test a/plain.test.js: sha256 ${'b'.repeat(64)}`,
    ],
    authors: [
      '  test a/authored.test.js: author core-7 (model) [family anthropic]; reviewer family none yet',
      '  test a/unauthored.test.js: author not recorded; reviewer family none yet',
    ],
  });
  assert.deepEqual(frozenLines(ITEM, null, { ...FACTS, reviewerFamilies: ['openai', 'anthropic'], testFiles: ['a/x.test.js'] }), {
    frozen: [], authors: ['  test a/x.test.js: author not recorded; reviewer family openai, anthropic'] }, 'no frozen bar prints no frozen lines');
});
