/** A landing counts its lapsed leases per head item, local to the board [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { finishLanding } from '../../src/io/finish.js';
import { LANDING_FINISH_STEPS } from '../../src/io/finish.js';
import { takeLandingResource } from '../../src/io/resource.js';
import * as store from '../../../store/index.js';
import { register as registerSeat } from '../../../store/index.js';
import { openCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';

const HEAD = 8933;

/** A file board whose clock stands behind the wall clock, so a lease taken on it lapses within about two seconds. */
function lapsingBoard(t) {
  const { root } = privateFixtureFiles('pullboard-stepaside-');
  const at = Date.now() - 118_000;
  const board = openCellBoard(join(root, 'board.sqlite'), { now: () => new Date(at) });
  registerSeat(board, { lane: 'coordinator', path: '/stepaside/main' });
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  return board;
}

/** Take a lease for the head item and wait until it lapses, then release it. */
async function lapseOnce(board) {
  let lapsed;
  const lostOnce = new Promise(resolve => { lapsed = resolve; });
  const held = await takeLandingResource({ board, branch: 'refs/heads/main', headItem: HEAD, onLost: error => lapsed(error.code),
    write: async (operation, args) => store[operation](board, ...args) });
  const alive = setInterval(() => {}, 1000);
  try { assert.equal(await lostOnce, 'LAND_LEASE_LOST'); }
  finally { clearInterval(alive); await held.release().catch(() => {}); }
}

test('landing.step-aside-count.a-lapsed-landing-lease-adds-one: clause 1: a lapsed landing lease adds one to the count under LANDING_LOCAL_PREFIX + stepaside: + the head item id [C7]', async t => {
  const board = lapsingBoard(t);
  assert.equal(store.stepAsideCount(board, HEAD), 0);
  await lapseOnce(board);
  assert.equal(store.stepAsideCount(board, HEAD), 1);
  await lapseOnce(board);
  assert.equal(store.stepAsideCount(board, HEAD), 2);
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`${store.LANDING_LOCAL_PREFIX}stepaside:${HEAD}`);
  assert.equal(row.meta_value, '2', 'the row is a JSON count under the prefix and the item id');
});

test('landing.step-aside-count.the-head-item-landing-deletes-its: clause 2: the head item landing deletes its count [C7]', async t => {
  const board = lapsingBoard(t);
  store.countLeaseLapse(board, HEAD);
  store.countLeaseLapse(board, 1);
  const steps = Object.fromEntries(LANDING_FINISH_STEPS.map(name => [name, () => null]));
  await finishLanding({ board, batch: { items: [{ id: HEAD }] } }, { steps });
  assert.equal(store.stepAsideCount(board, HEAD), 0);
  assert.equal(board.db.prepare('SELECT count(*) AS n FROM board_meta WHERE meta_key=?').get(store.stepAsideKey(HEAD)).n, 0, 'the key is gone');
  assert.equal(store.stepAsideCount(board, 1), 1, 'another head item keeps its count');
});

test('landing.step-aside-count.a-board-export-leaves-the-count: clause 3: a board export leaves the count out [C7]', async t => {
  const board = lapsingBoard(t);
  store.countLeaseLapse(board, HEAD);
  const exported = store.exportBoard(board);
  const keys = exported.tables.board_meta.map(row => row.meta_key);
  assert.ok(!keys.some(key => key.includes('stepaside')), keys.join(', '));
  assert.equal(store.stepAsideCount(board, HEAD), 1, 'the export did not remove it from the board');
});
