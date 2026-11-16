/** Empty landings preserve history without bypassing an existing landing owner [E25,E26,B3]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from "../../../../../packages/store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../../../packages/store/tests/fixtures/cell.js";
import { createE2eHelpers } from "../../../tests/fixtures/e2e.js";
import { landJobs } from "../../../tests/fixtures/land/board.js";
import { settleLand } from "../../../tests/fixtures/land/settle.js";

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Use production board functions only within this test's private fixture. */
function onBoard(box, work) {
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return work(board); } finally { store.closeBoard(board); }
}

// A plain `land` offers a runner land job; an idle one offers nothing and takes no lease [E25].
test('an idle empty land takes no lease and writes no event [E25,E26,B3]', async () => {
  const box = helpers.project('true');
  const before = onBoard(box, board => ({ events: store.events(board), lease: store.landingLeaseState(board) }));
  const head = box.git(box.repo, 'rev-parse', 'HEAD');
  const result = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(result.code, 0, result.err);
  assert.deepEqual((await settleLand(box, JSON.parse(result.out))).landed ?? [], []);
  assert.deepEqual(landJobs(box), [], 'an idle land offers no land job');
  assert.deepEqual(onBoard(box, board => ({ events: store.events(board), lease: store.landingLeaseState(board) })), before,
    'neither an admission generation nor any board event changes');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(onBoard(box, board => store.landingBatches(board).length), 0);
});
