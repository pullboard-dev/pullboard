/** @pullboard-world-pin builds the served page text and evaluates its dashboardModel declaration to prove the page carries what the model uses. */
/** The served page carries every helper the dashboard model imports, so it renders on the page [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cockpitPage } from '../../../src/io/cockpit/page.js';

/** The page text from one top-level `const name = (` up to the next top-level declaration. */
function declaration(served, name) {
  const start = served.indexOf(`\nconst ${name} = (`);
  assert.ok(start >= 0, `the served page declares ${name}`);
  const next = served.indexOf('\nconst ', start + 1);
  return served.slice(start, next > start ? next : undefined);
}

test('view.x-io-page-dashboard-bundle.clause-1-the-served-page-renders-the: clause 1: the served page renders the dashboard model without a missing helper [N26]', () => {
  const served = cockpitPage('', { snapshot: true, commandPhrases: () => ['add'] });
  const names = ['itemLanded', 'withdrawnFromStatus', 'itemStageKey', 'itemStagePresentation', 'dashboardModel'];
  const model = new Function(`${names.map((name) => declaration(served, name)).join('\n')}\nreturn dashboardModel;`)();
  const now = Date.parse('2026-11-15T12:00:00Z');
  const project = { items: [
    { id: 1, title: 'Landed by hand', status: 'withdrawn', merged: 'abc1234', lane: 'view' },
    { id: 2, title: 'Open', status: 'open', lane: 'view' },
  ], sequence: 0 };
  const state = model(project, [], { now, complete: false });
  assert.equal(state.stageCounts.merged, 1, 'the landed item counts as merged');
});
