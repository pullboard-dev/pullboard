/** A seat with a live claim commits with its item's trailer while that item's gate is queued or running [C7,#2639]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { fixture } from '../../../tests/fixtures/next/take.js';

/** Claim an item as the actor seat and queue its submit handoff, optionally started, as `submit --no-next` leaves it. */
function gating(box, title, { running }) {
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
  if (running) store.startSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id });
  return id;
}

for (const running of [false, true]) {
  test(`a live claim commits with the item trailer while its gate is ${running ? 'running' : 'queued'}; the hook does not refuse [C7,#2639]`, async t => {
    const box = await fixture(t);
    const id = gating(box, 'Gate in flight', { running });
    const cwd = box.seats.actor.path;
    mkdirSync(join(cwd, 'web'), { recursive: true });
    writeFileSync(join(cwd, 'web/fix.js'), 'export const fixed = true;\n');
    box.git(cwd, 'add', '-A');
    box.git(cwd, 'commit', '-q', '-m', 'fix(web): follow the red [G1]', '-m', `Pullboard-Item: #${id}`);
    assert.match(box.git(cwd, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${id}`, 'u'));
  });
}
