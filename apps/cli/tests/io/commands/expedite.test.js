/** @pullboard-test-input apps/cli/src/io/commands/expedite.js apps/cli/tests/fixtures/next/take.js */
/** pullboard expedite records a reasoned expedite for the coordinator only, capped by jobs.expediteMax, and an item whose gate settled stops counting [C7,#11812]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';
import { coordinatorHelp } from '../../../src/logic/help/coordinator.js';

const expediteEvents = box => box.board.db.prepare("SELECT event_by, item_id, event_detail FROM event WHERE event_kind = 'expedite' ORDER BY event_id").all();

test('cli.expedite.records-reason-coordinator-only: clause 1: pullboard expedite <id> --reason records one expedite event for the coordinator, is refused COORDINATOR_ONLY for a seat and USAGE without a reason [C7,#11812]', async t => {
  const box = await fixture(t);
  const id = box.add('Expedite me');
  const seat = await cli(box, box.seats.builder.path, ['expedite', String(id), '--reason', 'blocks the lander']);
  assert.notEqual(seat.code, 0, 'a seat cannot expedite');
  assert.match(seat.err + seat.out, /COORDINATOR_ONLY/u);
  const bare = await cli(box, box.root, ['expedite', String(id)]);
  assert.notEqual(bare.code, 0, 'a missing reason is refused');
  assert.match(bare.err + bare.out, /USAGE/u);
  assert.deepEqual(expediteEvents(box), [], 'a refused expedite records nothing');
  const done = await cli(box, box.root, ['expedite', String(id), '--reason', 'blocks the lander']);
  assert.equal(done.code, 0, done.err || done.out);
  const events = expediteEvents(box);
  assert.equal(events.length, 1, 'one event is recorded');
  assert.equal(events[0].item_id, id);
  assert.equal(events[0].event_by, 'coordinator');
  assert.equal(JSON.parse(events[0].event_detail).reason, 'blocks the lander');
  assert.deepEqual(store.expeditedItems(box.board), [id]);
  assert.match(coordinatorHelp, /pullboard expedite <id> --reason/u, 'help lists the command beside hold');
});

test('cli.expedite.cap-counts-only-in-flight: clause 2: a fourth expedite is refused naming jobs.expediteMax, and an item whose gate settled no longer counts [C7,#11812]', async t => {
  const box = await fixture(t);
  const ids = [1, 2, 3, 4].map(n => box.add(`Expedite candidate ${n}`));
  for (const id of ids.slice(0, 3)) {
    const done = await cli(box, box.root, ['expedite', String(id), '--reason', 'urgent']);
    assert.equal(done.code, 0, done.err || done.out);
  }
  const fourth = await cli(box, box.root, ['expedite', String(ids[3]), '--reason', 'urgent']);
  assert.notEqual(fourth.code, 0, 'the cap refuses a fourth');
  assert.match(fourth.err + fourth.out, /jobs\.expediteMax is 3/u);
  assert.equal(expediteEvents(box).length, 3, 'the refused expedite records nothing');
  store.logEvent(box.board, 'runner', 'run_applied', ids[0], { job: `gate:${ids[0]}:abc:1`, attempt: 1, outcome: 'green', state: 'done' });
  assert.deepEqual(store.expeditedItems(box.board), ids.slice(1, 3), 'a settled gate drops the item from the set');
  const again = await cli(box, box.root, ['expedite', String(ids[3]), '--reason', 'urgent']);
  assert.equal(again.code, 0, again.err || again.out);
});
