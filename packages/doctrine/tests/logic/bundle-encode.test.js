/** A rule bundle has canonical bytes, a digest that changes with any byte, and rules that keep their identity [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeBundle } from '../../src/logic/bundle/encode.js';
import { encodeBundle } from '../../src/logic/bundle/encode.js';

const BUNDLE = { version: 1, originBoardId: 'board-a', revision: 3,
  rules: [{ id: 'R1', text: 'one', scope: { lane: 'core', paths: ['a'] } }, { id: 'R2', text: 'two' }] };

test('clause 1: the same rules in any key order give the same bytes and digest [C7]', () => {
  const shuffled = { rules: [{ scope: { paths: ['a'], lane: 'core' }, text: 'one', id: 'R1' }, { text: 'two', id: 'R2' }],
    revision: 3, originBoardId: 'board-a', version: 1 };
  assert.deepEqual(encodeBundle(shuffled), encodeBundle(BUNDLE));
});

test('clause 1: a changed rule, revision or originBoardId changes the digest [C7]', () => {
  const base = encodeBundle(BUNDLE).digest;
  assert.match(base, /^[0-9a-f]{64}$/u);
  const changed = [
    { ...BUNDLE, rules: [{ ...BUNDLE.rules[0], text: 'ONE' }, BUNDLE.rules[1]] },
    { ...BUNDLE, revision: 4 },
    { ...BUNDLE, originBoardId: 'board-b' },
  ].map(bundle => encodeBundle(bundle).digest);
  assert.equal(new Set([base, ...changed]).size, 4);
});

test('clause 2: each rule keeps its origin and id in the bytes and decodes back identically [C7]', () => {
  const { bytes } = encodeBundle(BUNDLE);
  const decoded = decodeBundle(bytes);
  assert.deepEqual(decoded.rules.map(rule => [rule.originBoardId, rule.id]), [['board-a', 'R1'], ['board-a', 'R2']]);
  assert.deepEqual(encodeBundle(decoded), encodeBundle(BUNDLE));
  assert.deepEqual(decodeBundle(Buffer.from(bytes)), decoded);
});
