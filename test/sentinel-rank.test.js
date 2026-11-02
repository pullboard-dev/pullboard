/** Rank notices use the builder's real offer and explicit milestone order [N2,B13]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { healthReport } from '../packages/health/index.js';
import { dispatchHealth } from '../src/dispatch-health.js';
import { fixture, cli } from './next-take-fixture.js';

/** Read actual health findings for the fixture's native board. */
function inversion(box, id) {
  return healthReport({ db: box.board.db, root: box.root, config: box.config, now: box.clock.now(), dispatchHealth }).stuck
    .find(row => row.key === `RANK_INVERSION:item:${id}`);
}

test('a pinned claim stays above an unpinned free item [N2,B13]', async t => {
  const box = await fixture(t);
  const earlier = box.add('ordinary');
  const pinned = box.add('pinned');
  store.addMilestone(box.board, { agentId: 'coordinator', name: 'priority', reason: 'Fixture ranks work.', items: [earlier, pinned] });
  const result = await cli(box, box.root, ['milestone', 'pin', 'priority', String(pinned), '--reason', 'Fixture pins the claim']);
  assert.equal(result.code, 0, result.out + result.err);
  box.claim(pinned, box.seats.actor);
  assert.equal(inversion(box, pinned), undefined);
});

test('a held free item is not offered as an inversion [N2,B13]', async t => {
  const box = await fixture(t);
  const earlier = box.add('held work');
  const later = box.add('claim');
  const result = await cli(box, box.root, ['hold', String(earlier), 'Fixture hold']);
  assert.equal(result.code, 0, result.out + result.err);
  box.claim(later, box.seats.actor);
  assert.equal(inversion(box, later), undefined);
});

test('a takeable earlier item still raises one inversion [N2,B13]', async t => {
  const box = await fixture(t);
  const earlier = box.add('earlier');
  const later = box.add('later');
  box.claim(later, box.seats.actor);
  const result = inversion(box, later);
  assert.equal(result?.detail.ahead, earlier);
});
