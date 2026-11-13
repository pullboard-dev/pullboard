// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-view-test journey
 * Counts are checked against real rendered lists and native board sets through a live add. [N26] */
import { test } from 'node:test';
import { addCountItem } from '../../tests/fixtures/count-sweep.js';
import { liveMove } from '../../tests/fixtures/count-sweep.js';
import { pane } from '../../tests/fixtures/count-sweep.js';
import { withCountSweep } from '../../tests/fixtures/count-sweep.js';

// budget: native board setup and one sweep of every tab and filter choice; no speed threshold.
test('clause 1: every tab count describes its real list or named native set across an add refresh [N26]', { timeout: 240_000 }, async () => {
  await withCountSweep(async ({ box, demo, chrome }) => {
    await pane(chrome, 'settings', 'before add');
    await liveMove(chrome, () => addCountItem(box, demo.repo, 'Live added item', 'Count the live addition.'), 'data.project.items.length === 6', 'added');
  });
});
