/** Deleting every machine-home and runner cache file leaves show, gate selection and main-red answers unchanged [C7]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  boardAnswers,
  cacheFiles,
  cacheWipeBoard,
  wipeCaches,
} from '../../tests/fixtures/cache-wipe.js';

const board = cacheWipeBoard();
after(board.helpers.cleanup);

test('clause 1: wiping every machine home and runner cache file leaves show, gate selection and main-red answers equal [C7]', async () => {
  // The filing's baseline check settles on its own clock (pending, then green); capture the answers only once it has, so the wipe is the only change between them.
  await board.helpers.waitFor(() => !board.run(board.repo, 'show', String(board.item.item_id), '--json').out.includes('"result": "pending"'), 'the filing baseline check to settle');
  const before = await boardAnswers(board);
  assert.equal(before.show.code, 0, before.show.out);
  assert.ok(before.selection.inputKey, 'the selection answer names the test file by its input key');
  assert.ok(cacheFiles(board).length >= 4, 'the machine home and the runner root hold cache files before the wipe');
  wipeCaches(board);
  assert.deepEqual(cacheFiles(board), [], 'the wipe removed every cache file');
  assert.deepEqual(await boardAnswers(board), before, 'a cache was a second source of truth if any answer changed');
});
