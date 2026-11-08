/** A seat whose submit gate is running takes new work through the real CLI, and its trailers stay accepted [C7,#2882]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { main } from './native-cli-fixture.js';
import { cli, fixture } from './next-take-fixture.js';

/** Claim an item as the actor seat and start its submit handoff, as `submit --no-next` leaves it. */
function submitting(box, title) {
  box.board.gitRoot = box.root;
  const seat = box.seats.actor;
  const id = box.add(title);
  box.claim(id, seat);
  const head = box.git(seat.path, 'rev-parse', 'HEAD');
  const tree = box.git(box.root, 'rev-parse', `${head}^{tree}`);
  const item = store.getItem(box.board, id);
  const job = store.writeBoardCommand(box.board, 'queueSubmitHandoff', [id, { agentId: seat.id,
    job: randomUUID(), main: head, commit: head, tree, executionCommit: head, executionTree: tree,
    digest: item.item_frozen_digest, companionDigest: null, leaseMs: 7_200_000 }], seat.id).job;
  store.startSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id });
  return id;
}

test('next --take gives a seat with a running handoff a different item and no --wait [C7,#2882]', async t => {
  const box = await fixture(t);
  const held = submitting(box, 'Submitted and gating');
  const other = box.add('Another open item', { brief: 'Files: web/other.js\nTest: an unrelated file.' });
  let out = '', err = '';
  const code = await main(['next', '--take'], { cwd: box.seats.actor.path, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } }, stderr: { write: part => { err += part; } } });
  const text = out + err;

  assert.equal(code, 0, text);
  assert.match(text.split(/\r?\n/u, 1)[0], new RegExp(`^claimed #${other}:`, 'u'));
  assert.doesNotMatch(text, new RegExp(`submit ${held}\\b[^\\n]*--wait|next --wait`, 'u'), 'no --wait hint for the held item');
  assert.doesNotMatch(text, new RegExp(`you hold #${held}`, 'u'));
});

test('clause 2: a pending handoff counts as free for the two-minute oldest-review offer [C7,#3077]', async t => {
  const box = await fixture(t);
  submitting(box, 'Submit handoff frees the seat for review');
  const waiting = box.add('Review waiting two minutes');
  box.submit(waiting);
  const build = box.add('Another open build', { brief: 'Files: web/other.js\nTest: the unrelated build stays open.' });
  box.advance(2 * 60_000);
  const offered = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, waiting);
  assert.equal(offered.document.review, true);
  assert.equal(store.getItem(box.board, build).item_status, 'open');
});

test('the commit-msg hook accepts the submitted item trailer while its handoff runs [C7,#2882]', async t => {
  const box = await fixture(t);
  const id = submitting(box, 'Submitted and gating');
  const cwd = box.seats.actor.path;
  mkdirSync(join(cwd, 'web'), { recursive: true });
  writeFileSync(join(cwd, 'web/follow-up.js'), 'export const x = 1;\n');
  box.git(cwd, 'add', '-A');
  box.git(cwd, 'commit', '-q', '-m', 'fix(web): follow up [G1]', '-m', `Pullboard-Item: #${id}`);

  assert.match(box.git(cwd, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${id}`, 'u'));
});


test('next --take reserves the two-minute review while its only claim is a pending handoff (clauses 1 and 2) [C7,#3077]', async t => {
  const box = await fixture(t);
  const held = submitting(box, 'Only claim is gating');
  const before = store.getItem(box.board, held);
  const waiting = box.add('Review at the inclusive age boundary');
  box.submit(waiting);
  const build = box.add('Unclaimed build', { brief: 'Files: web/other.js\nTest: remains unclaimed.' });
  box.advance(2 * 60_000);
  const offered = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, waiting);
  assert.equal(offered.document.review, true);
  assert.equal(store.getItem(box.board, waiting).item_review_by, box.seats.actor.id);
  assert.equal(store.getItem(box.board, build).item_status, 'open');
  assert.equal(store.getItem(box.board, held).item_owner, before.item_owner);
  assert.equal(store.getItem(box.board, held).item_lease_until, before.item_lease_until);
  assert.ok(store.pendingSubmitHandoff(box.board, store.getItem(box.board, held)));
});
