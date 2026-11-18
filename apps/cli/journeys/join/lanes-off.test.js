/** With laneMode off, join takes no lane and next offers any item on the seat's route; with it on, join still needs a lane [C7,#2830]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

const FIXTURE_MODEL = 'claude-sonnet-5-5';

/** Make a fresh worktree beside the fixture's seats, so a join there is a first join. */
function freshWorktree(box, name) {
  const path = join(box.root, '..', name);
  box.git(box.root, 'worktree', 'add', '-q', '-b', `fresh/${name}`, path);
  return path;
}

test('cli.journeys-join-lanes-off.with-lanemode-off-join-with-no: clause 1: with laneMode off, join with no lane succeeds [C7,#2830]', async t => {
  const box = await fixture(t, { projectConfig: { laneMode: 'off' } });
  const path = freshWorktree(box, 'nolane');
  const joined = await cli(box, path, ['join', '--model', FIXTURE_MODEL]);
  assert.equal(joined.code, 0, joined.out + joined.err);
  assert.ok(joined.document.agent, 'the seat is registered');
});

test('cli.journeys-join-lanes-off.with-lanemode-off-next-offers-items: clause 2: with laneMode off, next offers items from two lanes the route covers [C7,#2830]', async t => {
  const box = await fixture(t, { projectConfig: { laneMode: 'off' } });
  const docs = box.add('Docs lane item', { lane: 'docs' });
  const web = box.add('Web lane item');
  const offered = [];
  for (let round = 0; round < 2; round += 1) {
    const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
    assert.equal(taken.code, 0, taken.out + taken.err);
    const id = taken.document.item.item_id;
    offered.push(id);
    assert.equal(store.getItem(box.board, id).item_owner, box.seats.actor.id);
    store.release(box.board, id, box.seats.actor.id, 'Return the fixture claim so the next selection moves on', 'OTHER');
    store.holdItem(box.board, id, { agentId: 'coordinator', reason: 'A real fixture hold' });
  }
  assert.deepEqual([...offered].sort((a, b) => a - b), [docs, web].sort((a, b) => a - b), 'the web seat is offered the docs-lane item and the web-lane item');
});

test('cli.journeys-join-lanes-off.with-lanemode-on-join-with-no: clause 3: with laneMode on, join with no lane is refused as today [C7,#2830]', async t => {
  const box = await fixture(t);
  const path = freshWorktree(box, 'nolane');
  const joined = await cli(box, path, ['join', '--model', FIXTURE_MODEL]);
  assert.notEqual(joined.code, 0, 'join with no lane is refused');
  assert.match(joined.out + joined.err, /NO_LANE/u);
});
