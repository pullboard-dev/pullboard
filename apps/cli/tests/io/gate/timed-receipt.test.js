/** A timed gate's exclusive receipt becomes the submit receipt in the board's gate receipt log, [C7,#8188]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../packages/store/tests/fixtures/cell.js';
import { runFixtureGit } from '../../fixtures/child.js';
import * as store from '../../../../../packages/store/index.js';
import { receiptLog } from '../../../../../packages/gate/index.js';
import { boardJobQueueCall } from '../../../../../packages/api/index.js';
import { claimJob } from '../../../../../packages/api/index.js';
import { offerJob } from '../../../../../packages/api/index.js';

/** Offer one gate job for a claimed item and post `extra` on top of a green receipt; returns the board, repo and answer. */
function postGate(t, extra) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const tree = String(runFixtureGit(['rev-parse', `${head}^{tree}`], { cwd: repo.root }).stdout).trim();
  const job = `gate:${item.item_id}:timed`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { data: { checkTiming: true } }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-timed', capabilities: [], now: 2 });
  const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-timed', token: lease.token,
    receipt: { version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] }, ...extra } }, { mode: 'pull', now: 3 });
  return { repo, board, item, posted };
}

test('cli.io-gate-timed-receipt.a-pulled-timed-gate-receipt-writes-the: clause 1: a pulled timed gate receipt writes the submit receipt in the gate receipt log [C7]', t => {
  const { repo, item, board, posted } = postGate(t, { timing: true, exclusive: true, unfencedClients: [], occupiedSlots: 4,
    admittedAt: '2026-11-15T18:00:00.000Z', finishedAt: '2026-11-15T18:00:30.000Z' });
  assert.equal(posted.applied.outcome, 'review', JSON.stringify(posted.applied));
  assert.equal(store.getItem(board, item.item_id).item_status, 'submitted');
  const rows = readFileSync(receiptLog(repo.root), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.deepEqual({ kind: rows[0].kind, timing: rows[0].timing, exclusive: rows[0].exclusive, occupiedSlots: rows[0].occupiedSlots, admittedAt: rows[0].admittedAt, finishedAt: rows[0].finishedAt, runMs: rows[0].runMs },
    { kind: 'submit', timing: true, exclusive: true, occupiedSlots: 4, admittedAt: '2026-11-15T18:00:00.000Z', finishedAt: '2026-11-15T18:00:30.000Z', runMs: 30_000 });
});

test('cli.io-gate-timed-receipt.an-untimed-pulled-gate-receipt-writes-no: clause 1: an untimed pulled gate receipt writes no submit receipt [C7]', t => {
  const { repo } = postGate(t, {});
  assert.throws(() => readFileSync(receiptLog(repo.root), 'utf8'), { code: 'ENOENT' });
});
