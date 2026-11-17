/** @pullboard-test-input source-cell board */
/** The board's provider loading lives in its own file, which the barrel re-exports [C7]. */
/** @pullboard-world-pin: clause 2 reads the providers file source to prove its only import is node:module. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bindBoardView as fromProviders } from '../src/io/providers.js';
import { bindBoardView as fromBarrel } from '../index.js';

test('clause 1: bindBoardView imported from providers.js is the function the board barrel exports [C7]', () => {
  assert.equal(typeof fromProviders, 'function');
  assert.equal(fromBarrel, fromProviders);
});

test('clause 2: importing providers.js does not load the board barrel, because its only import is node:module [C7]', () => {
  const source = readFileSync(new URL('../src/io/providers.js', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/^import .* from '([^']+)';$/gmu)].map(match => match[1]);
  assert.deepEqual(specifiers, ['node:module']);
  assert.equal(/\bimport\(/u.test(source), false, 'no dynamic import back to the barrel');
});
