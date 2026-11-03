/** `next` leads with its answer and keeps held queues readable [N2,C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { main } from './native-cli-fixture.js';
import { fixture } from './next-take-fixture.js';

/** Capture the native CLI's human answer without changing its board or environment contract. */
async function answer(box, args = ['next']) {
  let out = '', err = '';
  const code = await main(args, { cwd: box.seats.actor.path, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } },
    stderr: { write: part => { err += part; } } });
  return { code, text: `${out}${err}` };
}

test('no-item answer comes first and fifty held items fit in a short response [N2,C7]', async t => {
  const box = await fixture(t);
  for (let index = 0; index < 50; index++) {
    const id = box.add(`Held item ${index + 1}`);
    store.holdItem(box.board, id, { agentId: 'coordinator', reason: `fixture hold ${index + 1}` });
  }

  const result = await answer(box);
  const first = result.text.split(/\r?\n/u, 1)[0];

  assert.equal(result.code, 1);
  assert.match(first, /^pullboard: \[NOTHING_FREE\].*no item is free/u);
  assert.match(first, /50 items are held by coordinator/u);
  assert.doesNotMatch(first, /#\d+ is held by coordinator:/u);
  assert.ok(Buffer.byteLength(result.text) < 2048, `response was ${Buffer.byteLength(result.text)} bytes`);
});

test('claim action is the first line before skipped held work [N2,C7]', async t => {
  const box = await fixture(t);
  const held = box.add('Held item precedes the claim');
  store.holdItem(box.board, held, { agentId: 'coordinator', reason: 'Wait for its bar to be reworked' });
  const ready = box.add('Ready item to claim');

  const result = await answer(box);
  const first = result.text.split(/\r?\n/u, 1)[0];

  assert.equal(result.code, 0, result.text);
  assert.match(first, new RegExp(`^claimed #${ready}: Ready item to claim$`, 'u'));
  assert.ok(result.text.includes(`#${held} is held by coordinator: Wait for its bar to be reworked`));
  assert.equal(store.getItem(box.board, ready).item_owner, box.seats.actor.id);
});

test('an existing held claim is the first line [N2,C7]', async t => {
  const box = await fixture(t);
  const held = box.add('Already claimed work');
  box.claim(held, box.seats.actor);

  const result = await answer(box);
  const first = result.text.split(/\r?\n/u, 1)[0];

  assert.equal(result.code, 0, result.text);
  assert.match(first, new RegExp(`^you hold #${held}: Already claimed work$`, 'u'));
});

test('a returned red gate starts with the fix action [N2,C7]', async t => {
  const box = await fixture(t);
  box.board.gitRoot = box.root;
  const seat = box.seats.actor;
  const id = box.add('A failed gate returns to its builder');
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

  const result = await answer(box);
  const first = result.text.split(/\r?\n/u, 1)[0];

  assert.equal(result.code, 0, result.text);
  assert.match(first, new RegExp(`^red queued gate on #${id} A failed gate returns to its builder: GATE_RED:`,'u'));
});
