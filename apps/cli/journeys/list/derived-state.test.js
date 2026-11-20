/** pullboard list reads an accepted, unlanded item's verdict freshness from the derived-state table when the table is current for main [C7,#11373]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweepDerivedState } from '../../../../packages/health/index.js';
import { withFixtureBoard } from '../../tests/fixtures/board.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { fixtureSettledMachine } from '../../../../packages/gate/tests/fixtures/testkit.js';

/** A freshness no real projection of this fixture item gives: it can only reach list's output by being read from the table. */
const SENTINEL = { code: 'STALE_VERDICT', file: null, commit: null, reason: 'swept sentinel from the derived-state table' };

/**
 * An item the landing fixture built and accepted but did not land, and the helpers a case needs around it.
 * Why the Local helpers: the commit, submit and accept run in this process, not as a node start-up each [C7].
 */
async function acceptedItem(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  const home = box.env.PULLBOARD_MACHINE_HOME;
  fixtureSettledMachine(home, { test: { inProcessHooks: true } });
  const entry = await fixtures.itemWorktreeLocal(box, 1);
  await fixtures.commitItemLocal(box, entry);
  await fixtures.submitItemLocal(box, entry);
  await fixtures.acceptItemLocal(box, entry);
  /** Turn health.derivedState on or off in the fixture's machine settings. */
  const setting = on => fixtureSettledMachine(home, { test: { inProcessHooks: true }, health: { derivedState: on } });
  /** Sweep the table at the commit main is at now, every verdict row answering `state`. */
  const sweep = state => withFixtureBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), board => {
    const listItems = open => open.db.prepare('SELECT * FROM item ORDER BY item_id').all();
    return sweepDerivedState(board, { mainCommit: box.git(box.repo, 'rev-parse', 'main').trim(), enabled: true, listItems, verdictState: () => state, gateAtHead: () => null });
  });
  /** Move main one commit on with the same tree, so no reviewed path changes and the table swept before it is no longer current. */
  const moveMain = () => {
    const tree = box.git(box.repo, 'rev-parse', 'main^{tree}').trim();
    const next = box.git(box.repo, 'commit-tree', tree, '-p', 'main', '-m', 'chore: main moves on').trim();
    box.git(box.repo, 'update-ref', 'refs/heads/main', next);
  };
  /** The list --all --json document and the item's row in it. */
  const listed = async () => {
    const result = await box.runLocal(box.repo, 'list', '--all', '--json');
    assert.equal(result.code, 0, result.err);
    const doc = JSON.parse(result.out);
    return { doc, row: doc.items.find(item => item.item_id === entry.item) };
  };
  return { listed, setting, sweep, moveMain };
}

test('cli.journeys-list-derived-state.current: clause 1: with health.derivedState on and the table swept at the current main, list prints the same rows as with the setting off, and the table row answers the verdict freshness, not the projector [C7,#11373]', async t => {
  const { listed, setting, sweep } = await acceptedItem(t);
  setting(false);
  const computed = await listed();
  assert.ok(computed.row, 'the accepted item is listed');
  const fresh = computed.row.item_verdict_state ?? null;
  // The table holds what the projector computed: on and off print the same rows.
  setting(true);
  sweep(fresh);
  assert.deepEqual((await listed()).doc, computed.doc, 'a table of the computed state prints the same rows');
});

test('cli.journeys-list-derived-state.wired: clause 3: the production list command reads the table through verdictProjector: a state only the table holds is what list prints, and with the setting off it is never read [C7,#11373]', async t => {
  const { listed, setting, sweep } = await acceptedItem(t);
  setting(false);
  const fresh = (await listed()).row.item_verdict_state ?? null;
  // The table holds a state the projector cannot produce for this item: list prints it, so no event-log verdict read ran for the item.
  setting(true);
  sweep(SENTINEL);
  assert.deepEqual((await listed()).row.item_verdict_state, SENTINEL);
  setting(false);
  assert.equal((await listed()).row.item_verdict_state ?? null, fresh, 'with the setting off the same table is never read');
});

test('cli.journeys-list-derived-state.stale: clause 2: with the table swept at an older main commit, or with the setting off, list computes the verdict freshness itself and prints the same rows [C7,#11373]', async t => {
  const { listed, setting, sweep, moveMain } = await acceptedItem(t);
  setting(false);
  const computed = await listed();
  setting(true);
  sweep(SENTINEL);
  assert.deepEqual((await listed()).row.item_verdict_state, SENTINEL, 'the table is current before main moves');
  moveMain();
  assert.deepEqual((await listed()).doc, computed.doc, 'a table swept at an older main is ignored and the rows are computed');
  setting(false);
  assert.deepEqual((await listed()).doc, computed.doc, 'with the setting off the rows are computed');
});
