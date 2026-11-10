/** The board view marks claimed items that change the same files, and files outside their scope [N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overlapHtml } from '../../index.js';
import { overlapLines } from '../../index.js';
import { pageRenderScript } from '../../index.js';

const state = { claimOverlaps: {
  7: { files: ['src/a.js', 'src/b.js'], unknown: false,
    overlaps: [{ item: 9, builder: 'core-3', files: ['src/a.js'] }],
    outOfScope: [{ item: 12, files: ['src/z.js', 'src/y.js'] }] },
} };

test('an overlapping claim names the other item, its builder and the shared files, and out-of-scope files [N2]', () => {
  assert.deepEqual(overlapLines(state.claimOverlaps[7]), [
    'Same files as #9 (core-3): src/a.js',
    'Out of scope, belongs to #12: src/z.js, src/y.js',
  ]);
  const html = overlapHtml(state.claimOverlaps, 7);
  assert.match(html, /Same files as #9 \(core-3\): src\/a\.js/u);
  assert.match(html, /Out of scope, belongs to #12/u);
  assert.equal((html.match(/class="claim-overlap"/gu) || []).length, 2);
});

test('an item without an overlap entry shows nothing, and file names are escaped [N2]', () => {
  assert.equal(overlapHtml(state.claimOverlaps, 8), '');
  assert.equal(overlapHtml(undefined, 7), '');
  assert.match(overlapHtml({ 1: { overlaps: [{ item: 2, builder: '<b>', files: ['a&b.js'] }], outOfScope: [] } }, 1), /&lt;b&gt;.*a&amp;b\.js/u);
});

test('the page draws the overlap on list rows and in the detail from the state [N2]', () => {
  const script = pageRenderScript();
  assert.match(script, /const overlapHtml = /u);
  assert.equal((script.match(/overlapHtml\(data\.claimOverlaps, (i|item)\.id\)/gu) || []).length, 2);
});

test('the embedded page copy of overlapHtml runs with no module scope around it [N2]', () => {
  const embedded = new Function('return (' + overlapHtml.toString() + ')')();
  assert.match(embedded(state.claimOverlaps, 7), /Same files as #9 \(core-3\)/u);
});
