// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-view-test journey
 * Counts are checked against real rendered lists and native board sets through a live landing. [N26] */
import { test } from 'node:test';
import { liveMove } from '../../tests/fixtures/count-sweep.js';
import { pane } from '../../tests/fixtures/count-sweep.js';
import { withCountSweep } from '../../tests/fixtures/count-sweep.js';

// budget: native board setup and one sweep of every tab and filter choice; no speed threshold.
test('clause 1: every tab count describes its real list or named native set across a landing refresh [N26]', { timeout: 240_000 }, async () => {
  await withCountSweep(async ({ box, demo, chrome }) => {
    await pane(chrome, 'roadmap', 'before landing');
    await liveMove(chrome, async () => {
      box.git(demo.repo, 'merge', '--no-ff', '--no-edit', demo.itemBranches.get(`${demo.baseBranch}:1`));
      await box.runLocal(demo.repo, 'merged', '1', box.git(demo.repo, 'rev-parse', 'HEAD'));
    }, 'document.querySelectorAll("#roadmap [data-stage=merged]").length === 1', 'landed');
  });
});
