/** @pullboard-test-input apps/view/src/io/page/actions.js */
/** @pullboard-world-pin reads the shipped page script source to prove the phone detail reveal. */
/** #7403: the Dashboard gate card is as tall as its rows, runner rows read alike, a phone Items row opens below the nav [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dashboardModel } from '../../src/io/dashboard/model.js';
import { dashboardHtml } from '../../src/logic/render/dashboard.js';
import { composeViewStyles } from '../../src/io/styles.js';

const now = Date.parse('2026-11-12T18:00:00Z');
const until = new Date(now + 30 * 60_000).toISOString();
const model = runs => {
  const items = [{ id: 11, title: 'Builds the hero', status: 'claimed', lane: 'view', claim: { by: 'view-1', until }, updatedAt: until }];
  const events = [{ event_id: 1, event_kind: 'claim', item_id: 11, event_by: 'view-1', event_at: new Date(now - 60_000).toISOString(), event_detail: JSON.stringify({ leaseUntil: until }) }];
  const project = { items, events, sequence: 1, agents: [{ agent_id: 'view-1' }], milestones: [] };
  return { ...dashboardModel(project, events, { now, complete: true }), runners: { runners: [{ runner: 1, busy: true, jobs: runs, cpu: null, ram: null }], runs } };
};

test('view.x-io-dashboard-leftovers.clause-1-the-dashboard-queue-cards-are: clause 1: the Dashboard queue cards are only as tall as their rows [N26]', () => {
  const css = composeViewStyles();
  assert.match(css, /\.dash-queues \{[^}]*align-items: start;/u, 'a card is never stretched to its neighbour');
});

test('view.x-io-dashboard-leftovers.clause-2-every-runner-detail-row-reads: clause 2: every runner detail row reads item id when there is one, then the kind, then files done of total [N26]', () => {
  let html = '';
  try { html = dashboardHtml(model([
    { kind: 'test run', item: null, selected: 12, done: 0, minutesLeft: 0 },
    { kind: 'test run', item: 7386, selected: 9, done: 0, minutesLeft: 0 },
    { kind: 'test run', item: 4742 },
    { kind: 'gate', item: 7385 },
  ])); } catch (error) { assert.fail('the Dashboard did not render the runner rows: ' + error.message); }
  const rows = [...html.matchAll(/<div class="dash-j">(.*?)<\/div>/gu)].map(([, row]) => row.replace(/<[^>]*>/gu, '|').replace(/\|+/gu, '|').replace(/ \|/gu, '|'));
  assert.ok(rows.length >= 4, 'the runner rows are drawn: ');
  assert.ok(rows.some(row => /^\|test run\|· 0 of 12 files\|/u.test(row)), 'a run with no item: no id, then files done of total ');
  assert.ok(rows.some(row => /^\|#7386\|test run\|· 0 of 9 files\|/u.test(row)), 'a run with an item: id, then files done of total');
  assert.ok(rows.some(row => /^\|#4742\|test run\|/u.test(row)), 'a run with no file count shows only its id and kind');
  assert.ok(!rows.some(row => /^\|\d+ files?\|/u.test(row)), 'no row puts a file count where the id goes');
});

test('view.x-io-dashboard-leftovers.clause-3-opening-an-items-row-at: clause 3: opening an Items row at phone width puts the detail just below the nav and re-places it after the content lands [N26]', () => {
  const actions = readFileSync(new URL('../../src/io/page/actions.js', import.meta.url), 'utf8');
  const body = actions.match(/function reveal\(\) \{([\s\S]*?)\n\}/u)?.[1] ?? '';
  assert.match(body, /bar\.getBoundingClientRect\(\)\.bottom/u, 'the nav height sets the offset');
  assert.match(body, /behavior: 'instant'/u, 'no smooth scroll that later content can interrupt');
  assert.match(body, /place\(\);\s*requestAnimationFrame\(place\)/u, 'placed again after the detail fills in');
});
