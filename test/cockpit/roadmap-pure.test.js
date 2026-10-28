/** Release grouping, item rows and shipping HTML use explicit presentation data [N26,N38,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMilestoneModel } from '../../src/view/roadmap-render.js';
import { milestoneRowHtml } from '../../src/view/roadmap-render.js';
import { roadmapCardsHtml } from '../../src/view/roadmap-render.js';

test('Roadmap ranks supplied work by shipping stage and preserves modern and legacy completion rules [N26,N38,C7]', () => {
  const rows = [
    { label: '#1', state: 'verified', stage: 'merged' }, { label: '#2', state: 'open', stage: 'open', held: 'Hold' },
    { label: '#3', state: 'open', stage: 'open' }, { label: '#4', state: 'back', stage: 'open' },
    { label: '#5', state: 'building', stage: 'claimed' }, { label: '#6', state: 'verify', stage: 'submitted' },
    { label: '#7', state: 'verified', stage: 'accepted' }, { label: '#8', state: 'withdrawn', stage: 'withdrawn' },
  ];
  const milestone = { name: 'Upcoming', items: rows, summary: { total: 7, landed: 1, left: 6 } };
  const before = JSON.stringify({ rows, milestone }), read = readMilestoneModel(milestone, rows);
  assert.deepEqual(read.rows.map(row => row.label), ['#7', '#6', '#5', '#4', '#3', '#2', '#1']);
  assert.equal(read.done, 1);
  assert.equal(read.total, 7);
  assert.equal(read.shipped, false);
  assert.equal(readMilestoneModel({ ...milestone, summary: { total: 7, landed: 7, left: 0 } }, rows).shipped, true);
  assert.equal(readMilestoneModel({ name: 'Legacy', items: [1] }, [{ state: 'verified' }]).shipped, true);
  assert.equal(readMilestoneModel({ name: 'Empty', items: [] }, []).shipped, false);
  const malformed = readMilestoneModel({ name: 'Old', items: rows, landed: -1, total: '7' }, rows);
  assert.equal(malformed.done, 2, 'invalid counts use the historical visible-verified fallback');
  assert.equal(malformed.total, 7);
  assert.equal(JSON.stringify({ rows, milestone }), before);
});

test('milestone rows keep explicit disclosure, foreign navigation, pending detail and prepared text [N26,N38,C7]', () => {
  const row = { label: 'other#7', title: 'Title <seven>', state: 'open', stage: 'open', held: 'Wait <here>', pending: true,
    open: { root: '/other "board"', id: 7 }, block: { dot: '<i class="block-dot"></i>', detail: '<p>Prepared detail</p>' } };
  const html = milestoneRowHtml(row, { root: '/local', open: true, hidden: true, titleHtml: '<b>Prepared title</b>' });
  assert.match(html, /^<li hidden>/u);
  assert.match(html, /data-roadmap-key="i:other#7" aria-expanded="true" data-board="\/other &quot;board&quot;"/u);
  assert.match(html, /title="Title &lt;seven&gt;"/u);
  assert.match(html, /<b>Prepared title<\/b>/u);
  assert.match(html, /title="Wait &lt;here&gt;">held/u);
  assert.match(html, /class="milestone-why" aria-busy="true"><p>Prepared detail<\/p>/u);
  const accepted = milestoneRowHtml({ ...row, stage: 'accepted' }, { root: '/local', open: false });
  assert.match(accepted, /class="chip ok">accepted/u);
  assert.match(accepted, /class="milestone-why" hidden/u);
});

test('Roadmap cards preserve shipping counters, per-board folds and shipped history from prepared reads [N26,N38,C7]', () => {
  const upcoming = { name: 'Next <release>', items: [1, 2], limit: 4, count: 2, summary: { total: 2, landed: 0, left: 2,
    landing: 1, review: 0, building: 0, waiting: 0, held: 1 } };
  const rows = [{ label: '#1', state: 'verified', stage: 'accepted', title: 'Accepted' },
    { label: '#2', state: 'open', stage: 'open', title: 'Held', held: 'Wait' }];
  const next = readMilestoneModel(upcoming, rows);
  const shipped = readMilestoneModel({ name: 'Old', items: [3], note: 'First line\nFull note', shipped: { commit: 'a'.repeat(40) } },
    [{ label: '#3', state: 'verified', stage: 'merged', title: 'Landed' }]);
  const headers = new Map([[next, { count: '<b>Prepared count</b>', detail: '<div>Prepared progress</div>' }]]);
  const open = new Map([[JSON.stringify(['/local', 'm:' + upcoming.name]), false], [JSON.stringify(['/foreign', 'shipped']), true]]);
  const html = roadmapCardsHtml([next, shipped], { root: '/local', held: upcoming.name, open, headers,
    rows: new Map(rows.map(row => [row, { root: '/local', titleHtml: row.title }])) });
  assert.match(html, /data-roadmap-key="m:Next &lt;release&gt;"[^>]*aria-expanded="false"/u);
  assert.match(html, /Prepared count/u);
  assert.match(html, /Prepared progress/u);
  assert.match(html, /data-shipping-stage="landing"><dt>Accepted, landing<\/dt><dd>1<\/dd>/u);
  assert.match(html, /2\/4 items/u);
  assert.match(html, /<li hidden><div[^>]*data-roadmap-key="i:#1"/u);
  assert.match(html, /data-roadmap-key="shipped"[^>]*aria-expanded="false"/u, 'another board cannot unfold local history');
  assert.match(html, /class="roadmap-shipped-commit" title="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">aaaaaaaaaaaa/u);
  assert.match(html, /First line/u);
  assert.doesNotMatch(html, /undefined|NaN/u);
  assert.match(roadmapCardsHtml([]), /No milestones yet/u);
});
