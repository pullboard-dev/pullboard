// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-view-test journey
 * Counts are checked against real rendered lists and native board sets through a live claim. [N26] */
import { test } from 'node:test';
import { liveMove } from '../../tests/fixtures/count-sweep.js';
import { pane } from '../../tests/fixtures/count-sweep.js';
import { withCountSweep } from '../../tests/fixtures/count-sweep.js';

// budget: native board setup and one sweep of every tab and filter choice; no speed threshold.
test('clause 1: every tab count describes its real list or named native set across a claim refresh [N26]', { timeout: 240_000 }, async () => {
  await withCountSweep(async ({ box, demo, chrome }) => {
    await pane(chrome, 'dashboard', 'before claim');
    await liveMove(chrome, () => box.inProcess(demo.web, 'claim', '3'), 'document.querySelector("#dashboard [aria-label=Now] [data-dashboard-list=building] b")?.textContent === "1" && !!document.querySelector("#dashboard .dash-flow .dash-stage")', 'claimed');
  });
});
