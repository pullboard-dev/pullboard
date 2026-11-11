/** A verdict whose gate has no captured receipt is refused before any write transaction opens, so it holds no board lock [B3,C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../../index.js';
import { fixture } from '../../../fixtures/dispatch.js';

test('clause 1: a verdict on an item whose gate has no receipt is refused with no BEGIN IMMEDIATE [B3,C7]', t => {
  const box = fixture(t);
  const id = box.add('Gate still pending');
  box.submit(id);
  const item = store.getItem(box.board, id);
  const tree = box.git(box.root, 'rev-parse', `${item.item_commit}^{tree}`);
  store.writeBoardCommand(box.board, 'queueSubmitHandoff', [id, { agentId: box.seats.builder.id, job: randomUUID(),
    main: box.git(box.root, 'rev-parse', 'HEAD'), commit: item.item_commit, tree, executionCommit: item.item_commit,
    executionTree: tree, digest: item.item_frozen_digest, companionDigest: null, leaseMs: 7_200_000 }], box.seats.builder.id);
  const statements = [];
  const exec = box.board.db.exec.bind(box.board.db);
  box.board.db.exec = sql => { statements.push(String(sql)); return exec(sql); };
  assert.throws(() => store.writeBoardCommand(box.board, 'verify', [id, { agentId: box.seats.outside.id, decision: 'ACCEPT',
    head: item.item_commit, policy: 'any', digest: item.item_frozen_digest, note: 'checked' }], box.seats.outside.id), { code: 'GATE_PENDING' });
  assert.equal(statements.some(sql => /BEGIN/u.test(sql)), false);
});
