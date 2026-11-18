/** @pullboard-test-input source-cell packages/store */
/** With gate.machineVerifyPulled on, an applied green pulled-gate receipt lands a machine-eligible item with its clause receipts [C7,#10253]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { cellBoard } from '../fixtures/cell.js';
import { cellClaim } from '../fixtures/cell.js';
import { submitFixture } from '../fixtures/submit.js';
import { cellItem } from '../fixtures/cell.js';
import { cellRepo } from '../fixtures/cell.js';
import { cellSeat } from '../fixtures/cell.js';
import { applyRunReceipt } from '../../index.js';
import { getItem } from '../../index.js';
import { recordQueuedRun } from '../../index.js';

const CHECK = 'node --test one.test.js';
const CLAUSE = 'node --test two.test.js';
const COMMIT = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const MAIN = 'a'.repeat(40);
const sha = text => createHash('sha256').update(text).digest('hex');

/** A board holding one submitted item authorized for machine verification, and the two native receipts that prove it. */
function fixture(t) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const id = cellItem(board, { lane: 'web', title: 'Prove it by machine' }).item_id;
  cellClaim(board, id, seat, { root: repo.root });
  // Status moves only through the board's own moves, so the item is submitted by a real submit; the bar and its machine mark are then set beside it.
  submitFixture(board, id, { agentId: seat.id, commit: COMMIT, tree: TREE });
  board.db.prepare("UPDATE item SET item_criterion = '1. It works. [command]', item_check = ?, item_spec_ids = 'C7', item_brief = 'brief', item_files = 'docs/a.txt' WHERE item_id = ?").run(CHECK, id);
  const row = board.db.prepare('SELECT * FROM item WHERE item_id = ?').get(id);
  const digest = sha(JSON.stringify([row.item_criterion, row.item_check, row.item_spec_ids, row.item_brief]));
  const authorization = { version: 1, enabled: true, bar: digest, commands: [{ clause: 1, command: CLAUSE }] };
  const frozen = { ...(row.item_frozen ? JSON.parse(row.item_frozen) : {}), check: CHECK, machineVerification: authorization };
  board.db.prepare('UPDATE item SET item_frozen = ? WHERE item_id = ?').run(JSON.stringify(frozen), id);
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`machine_verification:${id}`, JSON.stringify(authorization));
  assert.equal(getItem(board, id).item_status, 'submitted');
  const receipt = (rid, command) => ({ id: rid, version: 2, green: true, command: sha(command), head: COMMIT, tree: TREE, main: MAIN,
    proof: { item: id, frozenDigest: row.item_frozen_digest, seat: seat.id, exitCode: 0, sourceClean: true, environment: { platform: 'test' } } });
  const stored = new Map([['r1', receipt('r1', CHECK)], ['r2', receipt('r2', CLAUSE)]]);
  // The native receipt store is a stand-in: the receipts are the ones a runner stored for this exact commit and tree.
  board.runtimePorts = { ...board.runtimePorts, sourceAdvanceReceipts: { ...board.runtimePorts?.sourceAdvanceReceipts,
    boardReceiptStore: () => 'store', readGateReceipt: (_store, rid) => stored.get(rid), receiptBody: value => JSON.stringify(value) } };
  board.nativePorts = { ...board.nativePorts, quarantine: { ...board.nativePorts?.quarantine, sealQuarantineVerdict: () => {} } };
  recordQueuedRun(board, { by: 'coordinator', id: 'gate-1', kind: 'gate', item: id, candidate: COMMIT, base: MAIN });
  return { board, id };
}

const GREEN = { outcome: 'review', summary: { gate: { green: true, source: MAIN }, machineReceipts: ['r1', 'r2'] } };

test('store.io-machine-pulled-lands.clause-1-green-receipt-accepts: clause 1: with gate.machineVerifyPulled on, a green applied receipt on a machine-eligible item records an accept verdict and the item reaches landing [C7,#10253]', t => {
  const { board, id } = fixture(t);
  const answer = applyRunReceipt(board, { by: 'coordinator', job: 'gate-1', attempt: 1, ...GREEN }, { machineVerifyPulled: true });
  assert.deepEqual(answer, { applied: true, machineAccepted: true });
  assert.equal(getItem(board, id).item_status, 'verified');
  const verdicts = board.db.prepare('SELECT verdict_decision, verdict_note FROM verdict WHERE item_id = ?').all(id);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].verdict_decision, 'ACCEPT');
  assert.match(verdicts[0].verdict_note, /receipt r1/u);
  assert.match(verdicts[0].verdict_note, /clause 1: node --test two\.test\.js \(receipt r2\)/u);
});

test('store.io-machine-pulled-lands.clause-2-setting-off-leaves-review: clause 2: with gate.machineVerifyPulled off the same green receipt leaves the item in review and records no verdict [C7,#10253]', t => {
  const { board, id } = fixture(t);
  const answer = applyRunReceipt(board, { by: 'coordinator', job: 'gate-1', attempt: 1, ...GREEN }, { machineVerifyPulled: false });
  assert.deepEqual(answer, { applied: true });
  assert.equal(getItem(board, id).item_status, 'submitted');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM verdict WHERE item_id = ?').get(id).n, 0);
});

test('store.io-machine-pulled-lands.clause-1-no-receipts-stays: clause 1: with the setting on, a green receipt naming no machine receipts leaves the item in review [C7,#10253]', t => {
  const { board, id } = fixture(t);
  const answer = applyRunReceipt(board, { by: 'coordinator', job: 'gate-1', attempt: 1, outcome: 'review', summary: { gate: { green: true, source: MAIN } } }, { machineVerifyPulled: true });
  assert.deepEqual(answer, { applied: true, machineAccepted: false });
  assert.equal(getItem(board, id).item_status, 'submitted');
});
