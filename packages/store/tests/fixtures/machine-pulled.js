/** The machine-pulled board fixture: a submitted machine-eligible item and the native receipts that prove it [C7,#10254]. */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { cellBoard } from './cell.js';
import { cellClaim } from './cell.js';
import { submitFixture } from './submit.js';
import { cellItem } from './cell.js';
import { cellRepo } from './cell.js';
import { cellSeat } from './cell.js';
import { getItem } from '../../src/io/board/query.js';
import { recordQueuedRun } from '../../src/io/board/run.js';

const CHECK = 'node --test one.test.js';
const CLAUSE = 'node --test two.test.js';
export const COMMIT = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
export const MAIN = 'a'.repeat(40);
const sha = text => createHash('sha256').update(text).digest('hex');

/** A board holding one submitted item authorized for machine verification, and the two native receipts that prove it. */
export function fixture(t, redClause) {
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
  const red = rid => ({ ...receipt(rid, CLAUSE), green: false, proof: { ...receipt(rid, CLAUSE).proof, exitCode: 1 } });
  const stored = new Map([['r1', receipt('r1', CHECK)], ['r2', redClause ? red('r2') : receipt('r2', CLAUSE)]]);
  // The native receipt store is a stand-in: the receipts are the ones a runner stored for this exact commit and tree.
  board.runtimePorts = { ...board.runtimePorts, sourceAdvanceReceipts: { ...board.runtimePorts?.sourceAdvanceReceipts,
    boardReceiptStore: () => 'store', readGateReceipt: (_store, rid) => stored.get(rid), receiptBody: value => JSON.stringify(value) } };
  board.nativePorts = { ...board.nativePorts, quarantine: { ...board.nativePorts?.quarantine, sealQuarantineVerdict: () => {} } };
  recordQueuedRun(board, { by: 'coordinator', id: 'gate-1', kind: 'gate', item: id, candidate: COMMIT, base: MAIN });
  return { board, id };
}
