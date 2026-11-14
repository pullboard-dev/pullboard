/** Release grouping, item rows and shipping HTML use explicit presentation data [N26,N38,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMilestoneModel } from '../../../../src/io/roadmap/render.js';
import { milestoneRowHtml } from '../../../../src/io/roadmap/render.js';
import { roadmapCardsHtml } from '../../../../src/io/roadmap/render.js';
import { roadmapRemainingCount } from '../../../../src/io/roadmap/render.js';
import { roadmapSummary } from '../../../../src/logic/summary/roadmap.js';

test('Roadmap title totals use shown header authority, retain legacy completion and exclude shipped history [N26,N38,C7]', () => {
  const modern = readMilestoneModel({ name: 'Next', items: [1, 2], shipped: null, summary: { total: 8, landed: 3, left: 5 } },
    [{ state: 'verified', stage: 'accepted' }]);
  const legacy = readMilestoneModel({ name: 'Old export', items: [3, 4] },
    [{ state: 'verified', stage: 'merged' }, { state: 'open', stage: 'open' }]);
  const shipped = { ...modern, shipped: true };
  assert.equal(roadmapRemainingCount([modern, legacy, shipped]), 6,
    'modern totals describe all remaining work even when the retained rows are partial');
  assert.equal(roadmapRemainingCount([modern]), 5, 'a selected release uses exactly its supplied header total');
  assert.equal(roadmapRemainingCount([modern, modern]), 10, 'the same item in two milestones contributes two roadmap entries');
  assert.equal(roadmapRemainingCount([]), 0);
  assert.equal(roadmapRemainingCount([shipped]), 0, 'shipped history does not become pending work');
  assert.equal(roadmapRemainingCount([{ milestone: {}, total: Infinity, done: 0 }]), null, 'invalid legacy totals remain unknown');
});

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
  const accepted = milestoneRowHtml({ ...row, state: 'verified', stage: 'accepted', held: '' }, { root: '/local', open: false });
  assert.match(accepted, /class="chip ok roadmap-stage-chip">Verified/u);
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
  const headers = new Map([[next, { top: '<b>Prepared header</b>', detail: '<div>Prepared progress</div>' }]]);
  const open = new Map([[JSON.stringify(['/local', 'm:' + upcoming.name]), false], [JSON.stringify(['/foreign', 'shipped']), true]]);
  const html = roadmapCardsHtml([next, shipped], { root: '/local', held: upcoming.name, open, headers,
    rows: new Map(rows.map(row => [row, { root: '/local', titleHtml: row.title }])) });
  assert.match(html, /data-roadmap-key="m:Next &lt;release&gt;"[^>]*aria-expanded="false"/u);
  assert.match(html, /Prepared header/u);
  assert.match(html, /Prepared progress/u);
  assert.doesNotMatch(html, /data-shipping-stage|roadmap-stage-counts|roadmap-last-shipped/u, 'the rail holds releases only');
  assert.doesNotMatch(html, /class="milestone-limit"/u, 'the prepared shared header replaces the extra total-and-limit line');
  assert.doesNotMatch(html, /limit 4/u, 'a distant capacity limit is not presented beside the item count');
  assert.doesNotMatch(html, /data-roadmap-key="i:#1"/u, 'a closed release draws no rows (#7303)');
  const shown = roadmapCardsHtml([next, shipped], { root: '/local', held: upcoming.name, open: new Map([[JSON.stringify(['/local', 'm:' + upcoming.name]), true]]), headers,
    rows: new Map(rows.map(row => [row, { root: '/local', titleHtml: row.title }])) });
  assert.match(shown, /<li hidden><div[^>]*data-roadmap-key="i:#1"/u, 'held shows only held rows in an open release');
  assert.match(html, /data-roadmap-key="shipped"[^>]*aria-expanded="false"/u, 'another board cannot unfold local history');
  const local = roadmapCardsHtml([next, shipped], { root: '/local', open: new Map([[JSON.stringify(['/local', 'shipped']), true]]), headers });
  assert.match(local, /class="roadmap-shipped-commit" title="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">aaaaaaaaaaaa/u);
  assert.match(local, /First line/u);
  assert.doesNotMatch(html, /undefined|NaN/u);
  assert.match(roadmapCardsHtml([]), /No milestones yet/u);
});

test('Roadmap names a limit only within ten percent and formats the forecast for people [N26]', () => {
  const rows = [{ label: '#1', state: 'open', stage: 'open', title: 'One item' }];
  /** Render one milestone count against its declared limit through the actual Roadmap card renderer. */
  const capacity = (count, limit = 700) => {
    const read = readMilestoneModel({ name: 'Capacity', items: [1], count, limit }, rows);
    return roadmapCardsHtml([read], { root: '/local', rows: new Map([[rows[0], { root: '/local', titleHtml: 'One item' }]]) });
  };
  assert.match(capacity(512), /<span class="milestone-limit">512 items<\/span>/u);
  assert.match(capacity(630), /<span class="milestone-limit">630 items · limit 700<\/span>/u, 'the inclusive lower threshold names the limit');
  assert.doesNotMatch(capacity(629), /limit 700/u, 'one below the lower threshold keeps the limit hidden');
  assert.match(capacity(770), /770 items · limit 700/u, 'the inclusive upper threshold names the limit');
  assert.doesNotMatch(capacity(771), /limit 700/u, 'one above the upper threshold keeps the limit hidden');
  assert.match(capacity(0, 0), /0 items · limit 0/u, 'a zero capacity is named only when exactly full');
  const shipped = readMilestoneModel({ name: 'Shipped', items: [], count: 512, limit: 700, shipped: { commit: 'a'.repeat(40) } }, []);
  assert.match(roadmapCardsHtml([shipped], { root: '/local', open: new Map([[JSON.stringify(['/local', 'shipped']), true]]) }), /<span class="milestone-limit">512 items<\/span>/u,
    'a shipped milestone keeps its count even when its limit is distant');

  const summary = { total: 512, landed: 0, left: 512, landing: 7, review: 0, building: 0, waiting: 0, held: 12,
    pace: { last6h: 7, last2h: 7 }, estimate: { low: 71, high: 212.5 }, window: '6h', reason: null };
  const header = roadmapSummary({ name: 'Capacity', summary }, { now: Date.parse('2026-10-28T12:00:00Z'), locale: 'en-US', timeZone: 'UTC' });
  assert.match(header.count, /512 to go/u);
  assert.doesNotMatch(header.top, /items an hour|landed in the last|done in about/u, 'no pace line; the notch owns it');
  assert.match(header.detail, /<i class="roadmap-summary-swatch held"[^>]*><\/i><b>12<\/b> <span>held<\/span>/u,
    'held retains the same dot, bold number, whitespace and separate label structure');
});

test('Roadmap renders open items in the backend queue position order and shows each position [N26,N38,C7]', () => {
  const rows = [
    { label: '#102', state: 'building', stage: 'claimed', position: 2 },
    { label: '#101', state: 'open', stage: 'open', held: 'Pinned', position: 1 },
  ];
  const read = readMilestoneModel({ name: 'Next', items: rows }, rows);
  assert.deepEqual(read.rows.map(row => row.label), ['#101', '#102']);
  const html = milestoneRowHtml({ label: '#101', state: 'open', stage: 'open', position: 1, why: '', title: 'T', block: { detail: '' } }, {});
  assert.match(html, /data-position="1"/);
  assert.match(html, /queue-position[^>]*>1</);
});

test('Roadmap rows use the approved plain status words and quiet linked waits [N26]', () => {
  const cases = [
    [{ stage: 'open', state: 'open' }, 'Ready'],
    [{ stage: 'claimed', state: 'building' }, 'Building'],
    [{ stage: 'submitted', state: 'verify' }, 'In review'],
    [{ stage: 'open', state: 'back' }, 'Sent back'],
    [{ stage: 'accepted', state: 'verified' }, 'Verified'],
    [{ stage: 'merged', state: 'verified' }, 'Merged'],
  ];
  for (const [state, label] of cases) {
    const html = milestoneRowHtml({ label: '#7', title: 'Row title', ...state }, {});
    assert.match(html, new RegExp('roadmap-stage-chip">' + label + '<', 'u'));
  }
  const waiting = milestoneRowHtml({ label: '#8', title: 'Waiting row', state: 'open', stage: 'open', after: [7],
    block: { dot: '<span class="block-dot"></span>', detail: '' } }, { afterHtml: '<span class="roadmap-after">after <a href="#items/7">#7</a></span>' });
  assert.ok(waiting.indexOf('Waiting row') < waiting.indexOf('roadmap-after'), 'the dependency follows the item title');
  assert.match(waiting, /after <a href="#items\/7">#7<\/a>/u);
  assert.doesNotMatch(waiting, /block-dot/u, 'the after link replaces the bare blocking dot');
});
