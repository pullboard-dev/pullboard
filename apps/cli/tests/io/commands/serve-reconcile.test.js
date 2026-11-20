/** @pullboard-test-input source-cell apps/cli packages/store packages/board packages/kernel packages/jobs */
/** pullboard serve settles the runs store's disagreements with the paced reconciler, and opens no runs file while the flag is off [B2,P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fixtureBoard } from '../../fixtures/board.js';
import { serveReconciler } from '../../../src/io/reconcile.js';
import { LOST_GRACE_MS } from '../../../../../packages/store/index.js';
import { RECONCILE_EVERY_MS } from '../../../../../packages/store/index.js';
import { boardRun } from '../../../../../packages/store/index.js';
import { recordQueuedRun } from '../../../../../packages/store/index.js';
import { runsFilePath } from '../../../../../packages/store/index.js';
import { writeBoardMeta } from '../../../../../packages/store/index.js';

/** A board file on a clock the test moves, with a loop whose timer the test stops; `opens` counts how often the loop opened the board. */
function served(t, { flag }) {
  const clock = { at: Date.parse('2026-11-15T12:00:00Z'), now() { return new Date(this.at); } };
  const board = fixtureBoard(t, { clock, storage: 'file', purpose: 'persistence' });
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  if (flag) writeBoardMeta(board.db, 'runs_store', '1');
  const world = { clock, board, file, opens: 0 };
  world.loop = serveReconciler({ withBoard: work => { world.opens += 1; return work(board); }, boardFile: file, clock: () => clock.at });
  t.after(() => world.loop.stop());
  return world;
}

test('cli.io-commands-serve-reconcile.serve-on-a-board-with-the-runs: clause 1: serve on a board with the runs_store flag on runs the reconciler tick at most once every 5 s [B2,P7]', t => {
  const world = served(t, { flag: true });
  recordQueuedRun(world.board, { by: 'coordinator', id: 'gate:lost', kind: 'gate' });
  world.clock.at += LOST_GRACE_MS + 1000;
  for (let beat = 0; beat < 12; beat += 1) {
    world.loop.offer();
    world.clock.at += 1000;
  }
  assert.equal(world.opens, 3, 'twelve one-second beats let three ticks through: at 0, 5 and 10 s');
  assert.ok(RECONCILE_EVERY_MS >= 5000);
  assert.equal(boardRun(world.board.db, 'gate:lost').run_state, 'lost', 'the first tick settled the run whose job the runs file never held');
  assert.equal(existsSync(runsFilePath(world.file)), true, 'with the flag on the loop opened the runs file');
});

test('cli.io-commands-serve-reconcile.serve-on-a-board-with-the-runs-2: clause 2: serve on a board with the runs_store flag off opens no runs file [B2,P7]', t => {
  const world = served(t, { flag: false });
  recordQueuedRun(world.board, { by: 'coordinator', id: 'gate:lost', kind: 'gate' });
  world.clock.at += LOST_GRACE_MS + 1000;
  for (let beat = 0; beat < 12; beat += 1) {
    world.loop.offer();
    world.clock.at += 1000;
  }
  assert.equal(existsSync(runsFilePath(world.file)), false, 'no runs file while the flag is off');
  assert.equal(boardRun(world.board.db, 'gate:lost').run_state, 'queued', 'the flag off leaves the board run alone');
});
