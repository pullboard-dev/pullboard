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
  ]);
  assert.deepEqual(found, [
    { file: 'a.js', name: 'renamed', problem: 'PARAM_MISMATCH' },
    { file: 'b.js', name: 'extra', problem: 'PARAM_MISMATCH' },
  ]);
});

test('gate.logic-jsdoc.untagged-and-destructured-not-stale: clause 1: jsdocFindings reports no PARAM_MISMATCH for a summary with no @param tags or for a documented name that stands for a destructured parameter, and still reports a documented top-level name the signature lacks [C7,#1807,#11428]', () => {
  const found = jsdocFindings([
    { file: 'a.js', name: 'untagged', params: ['x', 'y'], jsdoc: doc('Does it.', []) },
    { file: 'a.js', name: 'partial', params: ['x', 'y'], jsdoc: doc('Does it.', ['x']) },
    { file: 'a.js', name: 'destructured', params: [null, 'y'], jsdoc: doc('Does it.', ['opts', 'opts.a', 'y']) },
    { file: 'b.js', name: 'dotted', params: ['opts'], jsdoc: doc('Does it.', ['opts', 'opts.x']) },
    { file: 'b.js', name: 'stale', params: ['opts'], jsdoc: doc('Does it.', ['options.x']) },
    { file: 'b.js', name: 'renamed-beside-destructured', params: [null, 'y'], jsdoc: doc('Does it.', ['opts', 'other', 'y']) },
  ]);
  assert.deepEqual(found, [
    { file: 'b.js', name: 'stale', problem: 'PARAM_MISMATCH' },
    { file: 'b.js', name: 'renamed-beside-destructured', problem: 'PARAM_MISMATCH' },
  ]);
});

test('gate.logic-jsdoc.missing-summary-still-named: clause 2: an exported function with no JSDoc or an empty summary is still MISSING_SUMMARY, whatever its @param names are [C7,#1807,#11428]', () => {
  const found = jsdocFindings([
    { file: 'a.js', name: 'bare', params: ['x'], jsdoc: null },
    { file: 'a.js', name: 'empty', params: [null], jsdoc: doc('', ['opts']) },
    { file: 'a.js', name: 'documented', params: ['x'], jsdoc: doc('Does it.', ['x']) },
  ]);
  assert.deepEqual(found, [
    { file: 'a.js', name: 'bare', problem: 'MISSING_SUMMARY' },
    { file: 'a.js', name: 'empty', problem: 'MISSING_SUMMARY' },
  ]);
});
