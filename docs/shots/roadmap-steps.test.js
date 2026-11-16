/** The Roadmap capture's scroll and pager choices hold on a release of 350 items, in milliseconds and without Chrome [I11,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { centerScroll, pagerAction } from './roadmap-steps.mjs';

const VIEWPORT = 1000;
const ROW = 44;

test('centerScroll puts each of 350 synthetic rows inside the window, never above the page [I11,C7]', () => {
  for (let index = 0; index < 350; index += 1) {
    const pageTop = 300 + index * ROW;
    const scrollY = centerScroll({ top: pageTop, height: ROW, viewport: VIEWPORT, scrollY: 0 });
    assert.ok(scrollY >= 0, `row ${index} scrolls to a page position`);
    const top = pageTop - scrollY;
    assert.ok(top >= 0 && top + ROW <= VIEWPORT, `row ${index} sits inside the window after the scroll`);
    // Scrolling again from the new position lands on the same place: the choice does not drift.
    assert.equal(centerScroll({ top, height: ROW, viewport: VIEWPORT, scrollY }), scrollY, `row ${index} is stable`);
  }
});

test('centerScroll clamps an item near the top of the page to zero [I11,C7]', () => {
  assert.equal(centerScroll({ top: 10, height: ROW, viewport: VIEWPORT, scrollY: 0 }), 0);
});

test('pagerAction steps through pages until #1, which sits on a later page [I11,C7]', () => {
  const total = 351;
  const size = 50;
  const pages = [];
  for (let first = 0; first < total; first += size) pages.push(Array.from({ length: Math.min(size, total - first) }, (_, n) => `i:#${total - (first + n)}`));
  assert.equal(pages.at(-1).at(-1), 'i:#1', '#1 is on the last page');
  let page = 0;
  let steps = 0;
  for (;;) {
    const action = pagerAction({ keys: pages[page], target: 'i:#1', nextEnabled: page < pages.length - 1 });
    if (action === 'found') break;
    assert.equal(action, 'step', 'a later page exists, so the pager steps');
    page += 1;
    steps += 1;
    assert.ok(steps < pages.length, 'stepping ends');
  }
  assert.equal(page, pages.length - 1);
  assert.equal(steps, 7);
});

test('pagerAction reports missing when the last page lacks the item, and found on page one [I11,C7]', () => {
  assert.equal(pagerAction({ keys: ['i:#2'], target: 'i:#1', nextEnabled: false }), 'missing');
  assert.equal(pagerAction({ keys: ['i:#2', 'i:#1'], target: 'i:#1', nextEnabled: true }), 'found');
});
