/** @pullboard-test-input source-cell apps/cli */
/** The serve reconciler tick applies the receipts the runs inbox still holds, and opens no runs file while the flag is off [B2,P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fixtureBoard } from '../fixtures/board.js';
import { serveReconciler } from '../../src/io/reconcile.js';
import { claimJob } from '../../../../packages/api/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { postReceipt } from '../../../../packages/api/index.js';
import { queueFor } from '../../../../packages/api/index.js';
import { boardRun } from '../../../../packages/store/index.js';
import { runsFilePath } from '../../../../packages/store/index.js';
import { writeBoardMeta } from '../../../../packages/store/index.js';

const MAIN = 'a'.repeat(40);

/** A board file with the runs_store flag as asked and a serve loop on it; the timer is stopped when the test ends. */
function served(t, { flag }) {
  const clock = { at: Date.parse('2026-11-15T12:00:00Z'), now() { return new Date(this.at); } };
  const board = fixtureBoard(t, { clock, storage: 'file', purpose: 'persistence' });
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  if (flag) writeBoardMeta(board.db, 'runs_store', '1');
  const loop = serveReconciler({ withBoard: work => work(board), boardFile: file, clock: () => clock.at });
  t.after(() => loop.stop());
  return { board, file, loop };
}

/** Post `count` noop receipts straight to the runs file, so each waits in the inbox unapplied; returns the queue and the job ids. */
function strand(t, board, file, count) {
  const queue = queueFor(board, 'coordinator', { file });
  t.after(() => queue.runs.db.close());
  const ids = [];
  for (let n = 1; n <= count; n += 1) {
    const id = `note:${n}`, runner = `r${n}`, base = n * 10;
    offerJob(board.db, { id, kind: 'noop', item: null, candidate: MAIN, base: MAIN, needs: [], now: base + 1 }, queue);
    const held = claimJob(queue.runs.db, { runner, capabilities: [], now: base + 3 });
    assert.equal(held.job, id);
    assert.equal(postReceipt(queue.runs.db, { job: id, runner, token: held.token, receipt: { version: 1, status: 0 }, now: base + 4 }).recorded, true);
    ids.push(id);
  }
  return { queue, ids };
}

test('cli.io-reconcile.tick-applies-inbox: clause 1: with runs_store on, a serve reconciler tick applies a receipt left unapplied in the runs inbox [B2,P7]', t => {
  const world = served(t, { flag: true });
  const { queue, ids } = strand(t, world.board, world.file, 1);
  assert.equal(queue.port.receiptsSince(0, { limit: 100 }).length, 1, 'the receipt waits in the inbox before the tick');
  assert.equal(boardRun(world.board.db, ids[0]).run_state, 'queued');
  world.loop.offer();
  assert.equal(boardRun(world.board.db, ids[0]).run_state, 'done', 'the tick applied it');
});

test('cli.io-reconcile.tick-drains-three-receipts: clause 2: after three receipts and one tick with runs_store on the inbox holds no unapplied receipt [B2,P7]', t => {
  const world = served(t, { flag: true });
  const { queue, ids } = strand(t, world.board, world.file, 3);
  assert.equal(queue.port.receiptsSince(0, { limit: 100 }).length, 3);
  world.loop.offer();
  assert.deepEqual(queue.port.receiptsSince(0, { limit: 100 }), [], 'the inbox is empty after one tick');
  for (const id of ids) assert.equal(boardRun(world.board.db, id).run_state, 'done');
});

test('cli.io-reconcile.flag-off-opens-no-runs-file: clause 2: with runs_store off a serve reconciler tick opens no runs file [B2,P7]', t => {
  const world = served(t, { flag: false });
  world.loop.offer();
  assert.equal(existsSync(runsFilePath(world.file)), false, 'no runs file while the flag is off');
});
