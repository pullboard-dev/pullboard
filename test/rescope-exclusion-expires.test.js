/** A re-scope exclusion from a release expires when its reason is gone, so next offers the item again [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { healthReport } from '../packages/health/index.js';
import { dispatchHealth } from '../packages/sentinels/index.js';
import { main } from './native-cli-fixture.js';
import * as store from '../packages/store/index.js';
import { heartbeatSeat } from '../packages/store/index.js';
import { cli, fixture } from './next-take-fixture.js';

/** Claim an item for the actor seat and release it for re-scope. */
function giveBack(box, title, reason, options) {
  const id = box.add(title);
  box.claim(id, box.seats.actor);
  store.release(box.board, id, box.seats.actor.id, 'The fixture seat cannot build this item as scoped', options, reason);
  return id;
}

/** What the sibling builder seat is offered by the real next path. */
async function offeredTo(box) {
  const next = await cli(box, box.seats.builder.path, ['next', '--take']);
  return next.document?.item?.item_id ?? null;
}

test('clause 1: a ROUTED_ELSEWHERE release stays excluded while its seat is live and is offered again once the session is gone [C7]', async t => {
  const box = await fixture(t);
  const id = giveBack(box, 'Routed to a live seat', 'ROUTED_ELSEWHERE');
  box.advance(31 * 60_000);
  assert.notEqual(await offeredTo(box), id, 'the seat last beat 31 minutes ago: its session still holds the item');
  box.advance(20 * 60_000);
  assert.equal(await offeredTo(box), id, 'the session has been silent past the window');
});

test('clause 1: a ROUTED_ELSEWHERE release is offered again once the releasing seat folder is gone [C7]', async t => {
  const box = await fixture(t);
  const id = giveBack(box, 'Routed to a seat whose folder goes', 'ROUTED_ELSEWHERE');
  box.advance(31 * 60_000);
  heartbeatSeat(box.board, box.seats.actor.id);
  assert.notEqual(await offeredTo(box), id, 'live seat with its folder: excluded');
  box.git(box.root, 'worktree', 'remove', '--force', box.seats.actor.path);
  rmSync(box.seats.actor.path, { recursive: true, force: true });
  assert.equal(await offeredTo(box), id, 'the folder is gone');
});

test('clause 1: a BLOCKED release with no blocker list is offered again after the cooldown [C7]', async t => {
  const box = await fixture(t);
  const id = giveBack(box, 'Blocked with no list', 'BLOCKED');
  box.advance(31 * 60_000);
  assert.notEqual(await offeredTo(box), id, 'inside the cooldown');
  box.advance(31 * 60_000);
  assert.equal(await offeredTo(box), id, 'after the bounded cooldown');
});

test('clause 1: a BLOCKED release naming an unlanded blocker stays excluded until the blocker lands [C7]', async t => {
  const box = await fixture(t);
  const blocker = box.add('Unlanded blocker');
  const id = giveBack(box, 'Blocked on a named item', 'BLOCKED', { blockedOn: [blocker] });
  box.advance(24 * 60 * 60_000);
  assert.notEqual(await offeredTo(box), id, 'a day later the blocker is still unlanded');
});

test('clause 2: list, status data and the health report name each excluded item with its reason and age [C7]', async t => {
  const box = await fixture(t);
  const id = giveBack(box, 'Item excluded for re-scope', 'ROUTED_ELSEWHERE');
  box.advance(7 * 60_000);
  let listed = '';
  const code = await main(['list'], { cwd: box.seats.builder.path, clock: box.clock, stdout: { isTTY: false, write: part => { listed += part; } }, stderr: { write: () => {} } });
  assert.equal(code, 0, listed);
  assert.match(listed, new RegExp(`needs re-scope: #${id} .*ROUTED_ELSEWHERE.*released 7 min ago`, 'u'));
  const excluded = store.allItemsNeedingRescope(box.board);
  assert.equal(excluded[0].id, id);
  assert.match(excluded[0].reasons[0], /ROUTED_ELSEWHERE.*released 7 min ago/u);
  const finding = healthReport({ db: box.board.db, root: box.root, config: box.config, now: box.clock.now(), dispatchHealth }).stuck.find(row => row.cause === 'NEEDS_RESCOPE' && row.item === id);
  assert.match(finding.why, /released 7 min ago/u);
});
