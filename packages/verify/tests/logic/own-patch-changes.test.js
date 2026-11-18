/** @pullboard-test-input source-cell verify */
/** ownPatchChanges lists the hunks that differ between two versions of a submit's own patch, keyed by file and hunk header [C7,#2981,#9437]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedHunkHeaders } from '../../index.js';
import { ownPatchChanges } from '../../index.js';

/** One file's patch with the given hunks, each `[start, context, lines]`. */
function patch(file, hunks) {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunks.map(([start, context, lines]) => `@@ -${start},3 +${start},4 @@ ${context}\n ctx\n${lines}\n ctx\n`).join('')}`;
}

test('clause 1: ownPatchChanges returns the hunks that differ keyed by file and hunk header [C7,#2981,#9437]', () => {
  const before = patch('a.js', [[10, 'function one()', '+alpha'], [40, 'function two()', '+beta']]) + patch('b.js', [[5, 'function gone()', '+old']]);
  const after = patch('a.js', [[10, 'function one()', '+alpha'], [40, 'function two()', '+beta changed']]) + patch('c.js', [[1, 'function fresh()', '+new']]);
  assert.deepEqual(ownPatchChanges(before, after), [
    { file: 'a.js', header: 'function two()', change: 'changed' },
    { file: 'b.js', header: 'function gone()', change: 'removed' },
    { file: 'c.js', header: 'function fresh()', change: 'added' },
  ]);
});

test('clause 1: an unchanged hunk moved by a rebase is not listed [C7,#2981,#9437]', () => {
  const before = patch('a.js', [[10, 'function one()', '+alpha'], [40, 'function two()', '+beta']]);
  const moved = patch('a.js', [[210, 'function one()', '+alpha'], [260, 'function two()', '+beta']]);
  assert.deepEqual(ownPatchChanges(before, moved), []);
  assert.deepEqual(ownPatchChanges(before, before), []);
  assert.deepEqual(ownPatchChanges('', ''), [], 'two empty patches differ nowhere');
});

test('clause 1: two hunks under one header key apart by order, so a change to the second is found [C7,#2981,#9437]', () => {
  const before = patch('a.js', [[10, '', '+one'], [30, '', '+two']]);
  const after = patch('a.js', [[12, '', '+one'], [33, '', '+two edited']]);
  assert.deepEqual(ownPatchChanges(before, after), [{ file: 'a.js', header: '', change: 'changed' }]);
});

test('clause 1: a changed hunk in a file whose name Git quotes is found, and changedHunkHeaders names its full header [C7,#2981]', () => {
  const quoted = (lines) => `diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -5 +5 @@ context\n-old\n${lines}\n`;
  const before = quoted('+new');
  const after = quoted('+newer');
  assert.deepEqual(ownPatchChanges(before, after), [{ file: 'caf\u00e9.txt', header: 'context', change: 'changed' }]);
  assert.deepEqual(ownPatchChanges(before, before), []);
  assert.deepEqual(changedHunkHeaders(before, after), [{ file: 'caf\u00e9.txt', header: '@@ -5 +5 @@ context' }]);
});
