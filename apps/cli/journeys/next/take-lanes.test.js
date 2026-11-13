/** Lane, review-family and idle-seat dispatch cases that run beside take.test.js so no file passes the per-file time budget [N2,V1,B3,A6,B13,L2]. */
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';

test('ordinary next prefers its own lane, then names foreign work without claiming it [N2,B13,L2]', async t => {
  const box = crossLaneFixture(t);
  const web = box.seat('own-web', 'web', box.session, 'strong', true);
  const foreign = box.add('api', 'Earlier foreign work');
  const own = box.add('web', 'Ready own-lane work');
  box.milestone('earlier', foreign); box.milestone('later', own);
  const first = box.json((await box.runAsLocal(box.session, web.root, 'next', '--build', '--json')));
  assert.equal(first.item.item_id, own);
  assert.equal(first.item.item_owner, web.agent);
  box.json((await box.runAsLocal(box.session, web.root, 'release', String(own), '--reason', 'BLOCKED', '--no-next', '--json')));
  box.json((await box.runLocal(box.repo, 'hold', String(own), '--reason', 'Blocked own-lane fixture', '--json')));
  const worktrees = box.git(box.repo, 'worktree', 'list', '--porcelain');
  const next = (await box.runAsLocal(box.session, web.root, 'next', '--build', '--json'));
  assert.equal(next.code, 1, next.out);
  assert.match(JSON.parse(next.out).error.message, new RegExp(`#${foreign}\\b.*api lane`, 'u'));
  assert.equal(box.json((await box.runLocal(box.repo, 'show', String(foreign), '--json'))).item_status, 'open');
  assert.equal(box.git(box.repo, 'worktree', 'list', '--porcelain'), worktrees, 'next opens no seat or worktree');
});

test('ordinary next never claims for a dirty, occupied or peer target-lane seat [N2,B13,L2]', async t => {
  const box = crossLaneFixture(t);
  const web = box.seat('idle-web', 'web', box.session, 'strong', true);
  const dirty = box.seat('dirty-api', 'api', box.session);
  const busy = box.seat('busy-api', 'api', box.session);
  const peer = box.seat('peer-api', 'api', 'separate-peer-session');
  writeFileSync(join(dirty.root, 'uncommitted.txt'), 'retain these private fixture bytes\n');
  const occupied = box.add('api', 'An existing claim');
  box.json((await box.runAsLocal(box.session, busy.root, 'claim', String(occupied), '--json')));
  const free = box.add('api', 'Ready unowned work');
  const bindings = [dirty, busy, peer].map(seat => box.binding(seat.root));
  const next = (await box.runAsLocal(box.session, web.root, 'next', '--build', '--json'));
  assert.equal(next.code, 1, next.out);
  assert.equal(box.json((await box.runLocal(box.repo, 'show', String(free), '--json'))).item_status, 'open', 'the foreign item is named, not claimed');
  assert.deepEqual([dirty, busy, peer].map(seat => box.binding(seat.root)), bindings);
  assert.equal(box.git(dirty.root, 'status', '--porcelain'), '?? uncommitted.txt');
  assert.equal(box.json((await box.runLocal(box.repo, 'show', String(occupied), '--json'))).item_owner, busy.agent);
});

test('a review goes only to an independent seat [V1,B3]', async t => {
  const box = await fixture(t, { family: 'require' });
  const id = box.add('Independent review');
  box.submit(id);
  for (const name of ['sibling', 'sameFamily']) {
    const refused = await cli(box, box.seats[name].path, ['next', '--take']);
    assert.equal(refused.code, 1, refused.out + refused.err);
    assert.equal(store.getItem(box.board, id).item_review_by, null, 'neither shared parent nor shared family is independent');
  }
  const taken = await cli(box, box.seats.outside.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(store.getItem(box.board, id).item_review_by, box.seats.outside.id);
  assert.deepEqual(store.verdictsFor(box.board, id), [], 'assignment never fabricates a review verdict');
});

test('dispatch honors verify.family off while preserving independent sessions [V1,B3]', async t => {
  const box = await fixture(t, { family: 'off' });
  const id = box.add('Explicit family policy');
  box.submit(id);
  const sibling = await cli(box, box.seats.sibling.path, ['next', '--take']);
  assert.equal(sibling.code, 1, sibling.out + sibling.err);
  assert.equal(store.getItem(box.board, id).item_review_by, null, 'off never waives builder session independence');
  const taken = await cli(box, box.seats.sameFamily.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(store.getItem(box.board, id).item_review_by, box.seats.sameFamily.id, 'the declared off setting permits a different session of the same family');
});

test('ready work beside an idle seat for five minutes warns the coordinator [A6,N2]', async t => {
  const box = await fixture(t);
  const id = box.add('Unpaired ready work');
  const warnings = () => store.allShouts(box.board).filter(shout => shout.shout_to === 'coordinator'
    && shout.shout_text.startsWith('Stuck:') && shout.shout_text.includes(`#${id}`) && shout.shout_text.includes(box.seats.actor.id));
  box.advance(200000);
  store.appendFact(box.board, id, { agentId: 'coordinator', kind: 'note', text: 'A note does not change dispatch eligibility.' });
  box.advance(99999);
  box.scan();
  assert.equal(warnings().length, 0, 'the five-minute threshold is exact');
  box.advance(1);
  heartbeatSeat(box.board, box.seats.actor.id);
  box.scan();
  assert.equal(warnings().length, 1, 'the coordinator hears one concrete seat/item pairing');
  box.scan();
  assert.equal(warnings().length, 1, 'repeated observations of the same episode stay quiet');
  const result = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(result.code, 0, result.out + result.err);
  box.scan();
  assert.ok(store.getItem(box.board, id).item_owner);
  assert.equal(warnings().length, 1);
  assert.ok(store.allShouts(box.board).some(shout => shout.shout_text.startsWith('Resolved:') && shout.shout_text.includes('UNPAIRED_WORK')));
  store.release(box.board, id, box.seats.actor.id, 'Return the private fixture claim for the next selection', 'OTHER');
  box.scan();
  box.advance(299999);
  heartbeatSeat(box.board, box.seats.actor.id);
  box.scan();
  assert.equal(warnings().length, 1, 'a new episode must wait another whole five minutes');
  box.advance(1);
  box.scan();
  assert.equal(warnings().length, 2, 'clearing and reopening a pairing creates one new durable warning');
});
