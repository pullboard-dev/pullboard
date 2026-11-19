/** The pure JSDoc check names exported functions without a current summary [C7,#1807]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsdocFindings } from '../../src/logic/jsdoc.js';

const doc = (summary, params) => ({ summary, params });

test('gate.logic-jsdoc.names-a-missing-summary: clause 1: jsdocFindings(exports) returns the file and function of each exported function whose JSDoc summary is missing [C7,#1807]', () => {
  const found = jsdocFindings([
    { file: 'a.js', name: 'documented', params: ['x'], jsdoc: doc('Does it.', ['x']) },
    { file: 'a.js', name: 'bare', params: [], jsdoc: null },
    { file: 'b.js', name: 'blank', params: [], jsdoc: doc('  ', []) },
  ]);
  assert.deepEqual(found, [
    { file: 'a.js', name: 'bare', problem: 'MISSING_SUMMARY' },
    { file: 'b.js', name: 'blank', problem: 'MISSING_SUMMARY' },
  ]);
});

test('gate.logic-jsdoc.names-a-param-mismatch: clause 2: jsdocFindings returns the file and function of each exported function whose @param names differ from its signature [C7,#1807]', () => {
  const found = jsdocFindings([
    { file: 'a.js', name: 'same', params: ['x', 'y'], jsdoc: doc('Does it.', ['x', 'y']) },
    { file: 'a.js', name: 'renamed', params: ['word'], jsdoc: doc('Does it.', ['text']) },
    { file: 'b.js', name: 'extra', params: ['a'], jsdoc: doc('Does it.', ['a', 'b']) },
    { file: 'b.js', name: 'dropped', params: ['a', 'b'], jsdoc: doc('Does it.', ['a']) },
  ]);
  assert.deepEqual(found, [
    { file: 'a.js', name: 'renamed', problem: 'PARAM_MISMATCH' },
    { file: 'b.js', name: 'extra', problem: 'PARAM_MISMATCH' },
    { file: 'b.js', name: 'dropped', problem: 'PARAM_MISMATCH' },
  ]);
});
