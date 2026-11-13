/** next never hands a seat back the item it just released, nor offers it its own red gate as new work [N2,C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { main } from '../../tests/fixtures/native.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import { cli } from '../../tests/fixtures/next/take.js';

/** The native CLI's human answer for one command run at a seat. */
async function answer(box, seat, args) {
  let out = '', err = '';
  const code = await main(args, { cwd: seat.path, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } },
    stderr: { write: part => { err += part; } } });
  return { code, text: `${out}${err}` };
}

test('clause 1: after a seat releases an item, next and next --take offer it a different item for 30 minutes [N2,C7]', async t => {
  const box = await fixture(t);
  const seat = box.seats.actor;
  const released = box.add('Item the seat gives back');
  const other = box.add('Item the seat is offered instead');
  box.claim(released, seat);
  const gone = await cli(box, seat.path, ['release', String(released), '--reason', 'OTHER', '--note', 'giving it back', '--no-next']);
  assert.equal(gone.code, 0, gone.out + gone.err);
  assert.equal(store.getItem(box.board, released).item_status, 'open');
  box.advance(10 * 60_000);
  const next = await cli(box, seat.path, ['next', '--build']);
  assert.equal(next.code, 0, next.out + next.err);
  assert.equal(next.document.item.item_id, other, 'the released item is not offered back within the cooldown');
});

test('clause 2: next names a seat\'s own red gate as its work instead of offering new work [N2,C7]', async t => {
  const box = await fixture(t);
  box.board.gitRoot = box.root;
  const seat = box.seats.actor;
  const id = box.add('A red gate stays with its builder');
  box.add('Unrelated open item');
  box.claim(id, seat);
  const head = box.git(seat.path, 'rev-parse', 'HEAD');
  const tree = box.git(box.root, 'rev-parse', `${head}^{tree}`);
  const item = store.getItem(box.board, id);
  const job = store.writeBoardCommand(box.board, 'queueSubmitHandoff', [id, { agentId: seat.id,
    job: randomUUID(), main: head, commit: head, tree, executionCommit: head, executionTree: tree,
    digest: item.item_frozen_digest, companionDigest: null, leaseMs: 7_200_000 }], seat.id).job;
  store.startSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id });
  store.completeSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id,
    result: { code: 1, error: { code: 'GATE_RED', message: 'The fixture gate went red.', next: 'Fix the named source.' } } });
  const result = await answer(box, seat, ['next', '--build']);
  assert.equal(result.code, 0, result.text);
  assert.match(result.text.split(/\r?\n/u, 1)[0], new RegExp(`^red queued gate on #${id}: GATE_RED`, 'u'));
  assert.equal(store.getItem(box.board, id).item_owner, seat.id, 'the red gate stays with its builder');
});
