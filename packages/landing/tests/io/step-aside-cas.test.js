/** @pullboard-test-input packages/landing/src/io/land/fence.js */
/** @pullboard-test-input packages/landing/src/io/step/publish.js */
/** A lost landing compare-and-set adds to the same step-aside count a lapsed lease does [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { fenceHop } from '../../src/io/step/publish.js';
import { pushTrunkThroughFence } from '../../src/io/step/publish.js';
import * as store from '../../../store/index.js';
import { register as registerSeat } from '../../../store/index.js';

const HEAD = 8965;
const ITEM = 7;
const TRUNK = 'refs/heads/main';

/** A real file board, and a bare remote whose fence for ITEM has moved from epoch 1 to epoch 2, so a push at epoch 1 loses its compare-and-set. */
function lostFence(t) {
  const repo = cellRepo(t, { real: true });
  const { root: dir } = privateFixtureFiles('pullboard-step-aside-cas-');
  const remote = join(dir, 'remote.git');
  runFixtureGit(['clone', '-q', '--bare', repo.root, remote]);
  const board = openCellBoard(join(dir, 'board.sqlite'));
  registerSeat(board, { lane: 'coordinator', path: '/stepaside/main' });
  t.after(() => { store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  fenceHop(repo.root, { remote, item: ITEM, epoch: 1 });
  fenceHop(repo.root, { remote, item: ITEM, epoch: 2 });
  /** Push at the stale epoch 1, which the fence refuses, naming the head item whose count it should add to. */
  const lose = () => assert.throws(() => pushTrunkThroughFence(repo.root, { remote, branch: TRUNK, base: repo.commit, hop: { item: ITEM, epoch: 1 }, step: { board, headItem: HEAD } }), { code: 'HOP_FENCED' });
  return { board, lose };
}

test('landing.step-aside-cas.a-lost-compare-and-set-in: clause 1: a lost compare-and-set in the fence adds one to the step-aside count of the head item [C7]', t => {
  const { board, lose } = lostFence(t);
  assert.equal(store.stepAsideCount(board, HEAD), 0);
  lose();
  assert.equal(store.stepAsideCount(board, HEAD), 1);
  assert.equal(store.stepAsideCount(board, ITEM), 0, 'the hop item is not the head item, so it gains no count');
});

test('landing.step-aside-cas.one-lapse-plus-one-cas-loss: clause 2: one lapse plus one CAS loss reads as count 2 [C7]', t => {
  const { board, lose } = lostFence(t);
  store.countLeaseLapse(board, HEAD);
  lose();
  assert.equal(store.stepAsideCount(board, HEAD), 2);
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(store.stepAsideKey(HEAD));
  assert.equal(row.meta_value, '2', 'both losses share the one row');
});
