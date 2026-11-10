/** A queued red reaches its builder once per item event, including a new candidate head [C7,N2,V4]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { main } from '../../tests/fixtures/native.js';
import { fixture } from '../../tests/fixtures/next/take.js';

async function next(box) {
  let out = '', err = '';
  const code = await main(['next', '--wait', '0.001'], { cwd: box.seats.actor.path, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } }, stderr: { write: part => { err += part; } } });
  return { code, text: `${out}${err}` };
}

function red(box, id, seat, commit) {
  const tree = box.git(box.root, 'rev-parse', `${commit}^{tree}`);
  const item = store.getItem(box.board, id);
  const job = store.writeBoardCommand(box.board, 'queueSubmitHandoff', [id, { agentId: seat.id,
    job: randomUUID(), main: box.git(box.root, 'rev-parse', 'HEAD'), commit, tree,
    executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest, companionDigest: null,
    leaseMs: 7_200_000 }], seat.id).job;
  store.startSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id });
  store.completeSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id,
    result: { code: 1, error: { code: 'GATE_RED', message: 'Fixture gate is red.', next: 'Fix the named source.' } } });
}

test('clause 1: next delivers a queued red once; clause 2: a new candidate head is reported again [C7,N2,V4]', async t => {
  const box = await fixture(t);
  box.board.gitRoot = box.root;
  const seat = box.seats.actor;
  const id = box.add('A queued red needs one notice');
  box.claim(id, seat);
  const firstHead = box.git(seat.path, 'rev-parse', 'HEAD');
  red(box, id, seat, firstHead);

  const first = await next(box);
  const repeated = await next(box);
  assert.match(first.text, new RegExp(`red queued gate on #${id} A queued red needs one notice`, 'u'));
  assert.doesNotMatch(repeated.text, new RegExp(`red queued gate on #${id}`, 'u'));

  box.git(seat.path, 'commit', '--allow-empty', '-m', 'chore: prepare a new queued candidate [G1]');
  const secondHead = box.git(seat.path, 'rev-parse', 'HEAD');
  red(box, id, seat, secondHead);
  const newHead = await next(box);
  assert.match(newHead.text, new RegExp(`red queued gate on #${id} A queued red needs one notice`, 'u'));
});
