/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rowWindow } from '../../../src/logic/page/window.js';
import { composeViewStyles } from '../../../src/io/styles.js';

const pitch = 76, viewport = 900, count = 6700;

test('clause 2: Items draws only the rows near the screen, and scrolling the list reaches every item [N26]', () => {
  const first = rowWindow({ count, top: 120, viewport, pitch });
  assert.equal(first.start, 0, 'the first draw starts at the first row');
  assert.ok(first.end < 40, 'the first draw is a screenful and a margin of the 6,700 rows, not all of them: ' + first.end);
  const reached = new Set();
  let widest = 0;
  for (let scrolled = 0; scrolled <= count * pitch; scrolled += 300) {
    const { start, end } = rowWindow({ count, top: 120 - scrolled, viewport, pitch });
    widest = Math.max(widest, end - start);
    for (let row = start; row < end; row += 1) reached.add(row);
  }
  assert.equal(reached.size, count, 'every item is drawn at some scroll position');
  assert.ok(widest < 40, 'no position draws more than a screenful and its margin: ' + widest);
  const end = rowWindow({ count, top: 120 - count * pitch, viewport, pitch });
  assert.equal(end.end, count, 'the end of the list draws the last row');
  assert.deepEqual(rowWindow({ count: 0, top: 0, viewport, pitch }), { start: 0, end: 0 });
  assert.deepEqual(rowWindow({ count: 5, top: 0, viewport, pitch }), { start: 0, end: 5 }, 'a short list is drawn whole');
});

test('clause 2: the list keeps its whole height: rows are one fixed height, and the rows above and below are padding [N26]', () => {
  const css = composeViewStyles();
  assert.match(css, /#chain \{ --item-row-h: 55px;/u, 'the row height is one number the page reads');
  assert.match(css, /#chain > li\.row \{ height: var\(--item-row-h\);/u, 'every row is that height');
});
