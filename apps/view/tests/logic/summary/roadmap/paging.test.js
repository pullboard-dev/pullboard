/** #6841: a Roadmap release pages its landed items, 25 at a time unless 50 or 100 is chosen (#7556), after its moving items; the page and release ride in the address [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMilestoneModel } from '../../../../src/io/roadmap/render.js';
import { roadmapCardsHtml } from '../../../../src/io/roadmap/render.js';
import { placeQuery } from '../../../../src/logic/nav.js';
import { readRoadmapPlace } from '../../../../src/logic/nav.js';
import { withPlaceQuery } from '../../../../src/logic/nav.js';

const landed = (n) => Array.from({ length: n }, (_, i) => ({ label: '#' + (1000 + i), why: 'landed ' + i, state: 'verified', stage: 'merged' }));
const moving = [
  { label: '#1', why: 'blocked', state: 'open', stage: 'open', after: [2], block: { dot: '<i></i>', detail: '' } },
  { label: '#2', why: 'ready', state: 'open', stage: 'open' },
  { label: '#3', why: 'review', state: 'verify', stage: 'submitted' },
  { label: '#4', why: 'building', state: 'building', stage: 'claimed' },
];
const read = () => readMilestoneModel({ name: '0.9.4', items: [], summary: { total: 130, landed: 126, left: 4 } }, [...landed(126), ...moving]);
const html = (page) => roadmapCardsHtml([read()], { root: '/r', page });
const labels = (text) => [...text.matchAll(/<span class="id">(#\d+)<\/span>/gu)].map(([, id]) => id);

test('view.x-summary-roadmap-paging.clause-1-moving-items-come-first-then: clause 1: moving items come first, then one page of 25 landed items with a page control [N26]', () => {
  const ids = labels(html(null));
  assert.deepEqual(ids.slice(0, 4), ['#4', '#3', '#2', '#1'], 'building, in review, ready, then blocked');
  assert.equal(ids.length, 4 + 25, 'only 25 landed items render by default, never all');
  assert.equal(ids[4], '#1000');
  assert.match(html(null), /Landed 1–25 of 126 · page 1 of 6/u);
  assert.match(html(null), /data-roadmap-page="0\.9\.4" data-page="0" disabled/u, 'Previous is off on page 1');
  const last = html({ release: '0.9.4', page: 6 });
  assert.equal(labels(last).length, 4 + 1, 'the last page holds the remainder');
  assert.equal(labels(last)[4], '#1125');
  assert.match(last, /Landed 126–126 of 126 · page 6 of 6/u);
  assert.match(last, /data-page="7" disabled/u, 'Next is off on the last page');
  assert.equal(labels(html({ release: '0.9.4', page: 99 })).length, 4 + 1, 'a page past the end shows the last page');
  assert.equal(labels(html({ release: 'other', page: 2 })).length, 4 + 25, 'another release keeps its own first page');
});

test('view.x-summary-roadmap-paging.clause-2-the-pager-offers-25-50: clause 2: the pager offers 25, 50 and 100 per page and the chosen size sets the page [N26]', () => {
  const text = html(null);
  assert.deepEqual([...text.matchAll(/data-roadmap-per="(\d+)"[^>]*aria-pressed="(true|false)"/gu)].map(([, size, on]) => [size, on]), [['25', 'true'], ['50', 'false'], ['100', 'false']]);
  assert.equal(labels(html({ release: '0.9.4', page: 1, per: 50 })).length, 4 + 50);
  assert.match(html({ release: '0.9.4', page: 1, per: 50 }), /Landed 1–50 of 126 · page 1 of 3/u);
  assert.match(html({ release: '0.9.4', page: 1, per: 50 }), /data-roadmap-per="50"[^>]*aria-pressed="true"/u);
  assert.equal(labels(html({ release: '0.9.4', page: 2, per: 100 })).length, 4 + 26, 'with 100 a page holds 100 and the second holds the rest');
  assert.equal(labels(html({ release: '0.9.4', page: 1, per: 7 })).length, 4 + 25, 'an unknown size reads 25');
});

test('view.x-summary-roadmap-paging.clause-1-a-release-of-25-or: clause 1: a release of 25 or fewer landed items has no page control [N26]', () => {
  const small = readMilestoneModel({ name: 'S', items: [] }, [...landed(25), ...moving]);
  assert.doesNotMatch(roadmapCardsHtml([small], { root: '/r' }), /roadmap-pager/u);
  assert.match(roadmapCardsHtml([readMilestoneModel({ name: 'S', items: [] }, [...landed(26), ...moving])], { root: '/r' }), /roadmap-pager/u);
});

test('view.x-summary-roadmap-paging.clause-2-the-open-release-and-its: clause 2: the open release and its page are in the address and read back the same [N26]', () => {
  const search = withPlaceQuery('?k=x', placeQuery({ tab: 'roadmap', release: '0.9.4: Speed', page: 3 }));
  assert.equal(search, '?k=x&release=0.9.4%3A+Speed&page=3');
  assert.deepEqual(readRoadmapPlace(search), { release: '0.9.4: Speed', page: 3, per: 25 });
  const sized = withPlaceQuery('?k=x', placeQuery({ tab: 'roadmap', release: '0.9.4', page: 2, per: 100 }));
  assert.equal(sized, '?k=x&release=0.9.4&page=2&per=100', 'the page size rides in the address, 25 being the default');
  assert.deepEqual(readRoadmapPlace(sized), { release: '0.9.4', page: 2, per: 100 });
  assert.equal(readRoadmapPlace('?release=a&per=7').per, 25, 'an unknown size reads 25');
  assert.equal(withPlaceQuery('?k=x', placeQuery({ tab: 'roadmap', release: '0.9.4', page: 1 })), '?k=x&release=0.9.4', 'page 1 is the default');
  assert.equal(withPlaceQuery('?k=x', placeQuery({ tab: 'items', release: '0.9.4', page: 3 })), '?k=x', 'only the Roadmap carries them');
  assert.deepEqual(readRoadmapPlace(''), { release: null, page: 1, per: 25 });
  assert.deepEqual(readRoadmapPlace('?page=zzz&release=a'), { release: 'a', page: 1, per: 25 });
  assert.equal(withPlaceQuery('?k=x&release=a&page=2&per=50', []), '?k=x', 'leaving the Roadmap drops both');
});
