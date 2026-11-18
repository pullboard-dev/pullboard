/** #8060: the Dashboard's runner card lists the registered runners by name, with live load or 'offline' [C7,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHtml } from '../../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../../src/io/dashboard/model.js';
import { board } from './fixture.js';
import { now } from './fixture.js';

test('view.x-render-dashboard-runners.clauses-1-3-of-8060-one-row: clauses 1-3 of #8060: one row per registered runner by name, load or offline, and a count that equals the rows [C7]', () => {
  const { project, events } = board();
  project.dashboardRunners = { runners: [
    { runner: 1, name: '203.0.113.51', offline: false, busy: true, cpu: 40, ram: 50, jobs: [{ kind: 'gate', item: 6 }] },
    { runner: 2, name: '203.0.113.52', offline: true, busy: false, cpu: null, ram: null, jobs: [] },
    { runner: 3, name: '203.0.113.53', offline: false, busy: false, cpu: 5, ram: 20, jobs: [] }], runs: [] };
  const html = dashboardHtml(dashboardModel(project, events, { now, complete: true }));
  const card = html.slice(html.indexOf('aria-label="Runners"'));
  const rows = [...card.matchAll(/<tr class="[^"]*"><td class="mono">([^<]+)<\/td>[\s\S]*?<\/tr>/gu)];
  assert.deepEqual(rows.map(([, name]) => name), ['203.0.113.51', '203.0.113.52', '203.0.113.53']);
  assert.doesNotMatch(card, /Runner [0-9]/u, 'no placeholder name');
  assert.match(rows[1][0], /offline[\s\S]*offline/u, 'a runner with no heartbeat reads offline');
  assert.doesNotMatch(rows[1][0], /—/u, 'never a bare dash');
  assert.match(rows[0][0], /40%/u);
  assert.match(card, /data-count="runners">3</u, 'the count is the registered runners');
});
