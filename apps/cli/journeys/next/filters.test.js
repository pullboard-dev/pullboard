/** Idle observations preserve native skip identities under focus and stats count their seat time [C7,#3080]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fixture,
  cli,
} from '../../tests/fixtures/next/take.js';
import * as store from '../../../../packages/store/index.js';
import { board_recordNextIdle as recordNextIdle } from '../../../../packages/store/index.js';
const { nextIdleChanged } = store;
import { idleSkipMinutes } from '../../../../packages/stats/index.js';

test('clause 1 and clause 2: focused idle next records the first refusal for its top three candidates and stats reports their last-24h seat minutes [C7,#3080]', async t => {
  const box = await fixture(t, { family: 'require' });
  const ids = Array.from({ length: 4 }, (_, n) => box.add(`Same-family review ${n}`));
  for (const id of ids) box.submit(id);
  for (const args of [
    ['milestone', 'add', 'Focused', '--items', ids.join(','), '--reason', 'Exercise real focus filtering'],
    ['milestone', 'focus', 'Focused', '--overflow', 'off'],
  ]) {
    const result = await cli(box, box.root, args);
    assert.equal(result.code, 0, result.out + result.err);
  }
  const next = await cli(box, box.seats.actor.path, ['next', '--verify']);
  assert.equal(next.code, 1, next.out + next.err);
  const event = store.events(box.board).findLast(row => row.event_kind === 'next-idle' && row.event_by === box.seats.actor.id);
  assert.ok(event, next.out + next.err);
  const detail = JSON.parse(event.event_detail);
  assert.deepEqual(detail.skips, ids.slice(0, 3).map(item => ({ item, code: 'SAME_FAMILY' })), 'focus retains the underlying first guard, not just the focus label');
  box.advance(30 * 60_000);
  const build = box.add('End this seat idle interval');
  box.claim(build, box.seats.actor);
  box.advance(15 * 60_000);
  const stats = await cli(box, box.seats.actor.path, ['stats']);
  assert.equal(stats.code, 0, stats.out + stats.err);
  assert.deepEqual(stats.document.idleSkips.rows, [{ code: 'SAME_FAMILY', seatMinutes: 30 }], 'three candidate details count one seat interval, and a claim ends it');
});

test('clause 2: changed first skip evidence starts a new observation even when its broad idle reason is unchanged [C7,#3080]', async t => {
  const box = await fixture(t);
  const seat = box.seats.actor.id;
  recordNextIdle(box.board, { agentId: seat, reason: 'focus', skips: [{ item: 1, code: 'ITEM_HELD' }] });
  box.advance(10 * 60_000);
  assert.equal(nextIdleChanged(box.board, { agentId: seat, reason: 'focus', skips: [{ item: 2, code: 'DEPENDENCY' }] }), true);
  recordNextIdle(box.board, { agentId: seat, reason: 'focus', skips: [{ item: 2, code: 'DEPENDENCY' }] });
  box.advance(20 * 60_000);
  assert.deepEqual(idleSkipMinutes(store.events(box.board), box.clock.now().getTime()).rows,
    [{ code: 'DEPENDENCY', seatMinutes: 20 }, { code: 'ITEM_HELD', seatMinutes: 10 }]);
  box.advance(24 * 60 * 60_000);
  assert.deepEqual(idleSkipMinutes(store.events(box.board), box.clock.now().getTime()).rows,
    [{ code: 'DEPENDENCY', seatMinutes: 1440 }], 'carry-in is clipped to the window; older causes contribute nothing');
});

test('clause 1: an empty other-lane fallback retains this seat own build filters [C7,#3080]', async t => {
  const box = await fixture(t);
  const ids = [box.add('Held build one'), box.add('Held build two')];
  for (const id of ids) store.holdItem(box.board, id, { agentId: 'coordinator', reason: 'Native fixture hold' });
  const result = await cli(box, box.seats.actor.path, ['next', '--build']);
  assert.equal(result.code, 1, result.out + result.err);
  const event = store.events(box.board).findLast(row => row.event_kind === 'next-idle' && row.event_by === box.seats.actor.id);
  assert.ok(event, result.out + result.err);
  assert.deepEqual(JSON.parse(event.event_detail).skips, ids.map(item => ({ item, code: 'ITEM_HELD' })));
});
