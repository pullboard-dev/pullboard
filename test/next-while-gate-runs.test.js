/** A seat whose only held items are submitted is offered new work by next; a red brings it back first [B3,N2]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, cli } from './next-take-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { completeSubmitHandoff } from '../packages/store/index.js';
import { startSubmitHandoff } from '../packages/store/index.js';
import { writeBoardCommand } from '../packages/store/index.js';
import { shout } from '../packages/store/index.js';
import * as store from '../packages/store/index.js';

/** A fixture whose actor seat holds a claimed item and has a second item open for it. */
async function seatWithClaim(t) {
  const box = await fixture(t);
  box.board.gitRoot = box.root;
  const seat = box.seats.actor;
  const first = box.add('Submitted and waiting on its gate', { brief: 'Files: web/first.js\nTest: submitted work stays the seat\'s own.' });
  const second = box.add('New work offered while the first is checked', { brief: 'Files: web/second.js\nTest: the idle seat builds on.' });
  const claimed = await cli(box, seat.path, ['claim', String(first), '--no-next']);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const head = box.git(seat.path, 'rev-parse', 'HEAD');
  return { box, seat, first, second, head, tree: box.git(box.root, 'rev-parse', `${head}^{tree}`) };
}

/** Queue the claimed item's gate exactly as submit does, with no worker behind it. */
function queue({ box, seat, first, head, tree }) {
  const item = store.getItem(box.board, first);
  return writeBoardCommand(box.board, 'queueSubmitHandoff', [first, { agentId: seat.id, job: randomUUID(), main: head, commit: head, tree,
    executionCommit: head, executionTree: tree, digest: item.item_frozen_digest, companionDigest: null, leaseMs: 7_200_000 }], seat.id).job;
}

test('next offers new work while the seat\'s item is in review [B3,N2]', async t => {
  const { box, seat, first, second, head, tree } = await seatWithClaim(t);
  submitFixture(box.board, first, { agentId: seat.id, commit: head, tree });
  assert.equal(store.getItem(box.board, first).item_status, 'submitted');
  const offered = await cli(box, seat.path, ['next', '--build']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, second, 'a submitted item does not hold the seat idle');
  assert.equal(store.getItem(box.board, first).item_owner, seat.id, 'the submitted item stays the seat\'s own');
});

test('next offers new work while the gate is queued or running, and the red item comes back first [B3,N2]', async t => {
  const context = await seatWithClaim(t);
  const { box, seat, first, second } = context;
  const job = queue(context);
  assert.equal(job.state, 'queued');
  startSubmitHandoff(box.board, first, { agentId: seat.id, job: job.id });
  const offered = await cli(box, seat.path, ['next', '--build']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, second, 'a running gate does not hold the seat idle');
  assert.equal(store.getItem(box.board, first).item_status, 'claimed');
  assert.equal(store.getItem(box.board, first).item_owner, seat.id, 'the queued item stays the seat\'s own');
  const release = await cli(box, seat.path, ['release', String(second), '--reason', 'ROUTED_ELSEWHERE', '--no-next']);
  assert.equal(release.code, 0, release.out + release.err);
  completeSubmitHandoff(box.board, first, { agentId: seat.id, job: job.id,
    result: { code: 1, error: { code: 'GATE_RED', message: 'The fixture gate went red.', next: 'Fix the named source.' } } });
  const back = await cli(box, seat.path, ['next', '--build']);
  assert.equal(back.code, 0, back.out + back.err);
  assert.equal(back.document.item.item_id, first, 'the red item returns before any new work');
  assert.equal(back.document.held, true);
});

test('a backlog shout naming a withdrawn item does not end next --wait while the seat has work to be offered [B3,N2]', async t => {
  const { box, seat, first, second } = await seatWithClaim(t);
  const done = box.add('Finished before the shout is read', { brief: 'Files: web/done.js\nTest: finished work asks nothing.' });
  shout(box.board, { from: 'coordinator', to: seat.id, text: `fix #${done} before the review lands, the owner asked`, lanes: ['web', 'review', 'docs'] });
  store.withdraw(box.board, done, { agentId: 'coordinator', reason: 'finished before the shout' });
  const offered = await cli(box, seat.path, ['next', '--build', '--wait', '1']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.notEqual(offered.document.item.item_id, done, 'the withdrawn item is not offered');
  assert.ok([first, second].includes(offered.document.item.item_id), 'the seat is offered its own or new work');
}
);
