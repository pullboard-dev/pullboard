/** @pullboard-test-input source-cell board */
/** The board's native open path lives in its own file, which the barrel re-exports [C7,#9823]. */
/** @pullboard-world-pin: clause 2 reads the open file source to prove it never imports the board barrel. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as own from '../src/io/open.js';
import * as barrel from '../index.js';

const NAMES = ['openBoard', 'openBoardForRead', 'nativeBoardPorts'];

test('clause 1: openBoard, openBoardForRead and nativeBoardPorts imported from open.js are the functions the board barrel exports [C7,#9823]', () => {
  for (const name of NAMES) {
    assert.equal(typeof own[name], 'function', name);
    assert.equal(barrel[name], own[name], name);
  }
});

test('clause 2: importing open.js does not load the board barrel, because it imports only the providers file and the store [C7,#9823]', () => {
  const source = readFileSync(new URL('../src/io/open.js', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/^import .* from '([^']+)';$/gmu)].map(match => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.notEqual(new URL(specifier, 'file:///x/packages/board/src/io/').pathname, '/x/packages/board/index.js', specifier);
  assert.equal(/\bimport\(/u.test(source), false, 'no dynamic import back to the barrel');
});
