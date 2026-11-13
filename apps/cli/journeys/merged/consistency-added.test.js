// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-view-test journey
 * Counts are checked against real rendered lists and native board sets through a live add. [N26] */
import { test } from 'node:test';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { liveMove } from '../../tests/fixtures/count-sweep.js';
import { pane } from '../../tests/fixtures/count-sweep.js';
import { withCountSweep } from '../../tests/fixtures/count-sweep.js';

// budget: native board setup and one sweep of every tab and filter choice; no speed threshold.
test('clause 1: every tab count describes its real list or named native set across an add refresh [N26]', { timeout: 240_000 }, async () => {
  await withCountSweep(async ({ box, demo, chrome }) => {
    await pane(chrome, 'settings', 'before add');
    await liveMove(chrome, () => fileFixtureItem(box, demo.repo, { lane: 'web', title: 'Live added item', criterion: 'Count the live addition.', check: null, args: ['--specs', 'G1'] }), 'data.project.items.length === 6', 'added');
  });
});
