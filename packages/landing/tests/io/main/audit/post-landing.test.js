/** After a landing is recorded the audit is a board job: it writes an audit proof-run naming the item and its landed commit [C7,#4743]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../../board/tests/fixtures/cell-board.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';
import * as store from '../../../../../store/index.js';
import { recordLandingAudit } from '../../../../src/io/merged/followup.js';

const LANDED = 'c'.repeat(40);

test('landing.post-landing.the-audit-job-records-an-audit: clause 1: the audit job records an audit proof-run naming the item and its landed commit, once per landing [C7,#4743]', t => {
  const board = cellBoard(t, ':memory:');
  cellSeat(board, { lane: 'coordinator', path: '/coordinator' });
  const id = cellItem(board, { lane: 'core', title: 'Audited landing', route: 'strong' }).item_id;
  assert.deepEqual(store.proofReceipts(board, id), [], 'nothing is audited before a landing');
  const receiptId = recordLandingAudit(board, id, LANDED, 'coordinator');
  const [audit] = store.proofReceipts(board, id);
  assert.equal(audit.kind, 'audit');
  assert.equal(audit.item, id);
  assert.equal(audit.commit, LANDED, 'the audit names the landed commit');
  assert.equal(audit.id, receiptId);
  assert.equal(recordLandingAudit(board, id, LANDED, 'coordinator'), null, 'a replayed landing audits once');
  assert.equal(store.proofReceipts(board, id).length, 1);
});
