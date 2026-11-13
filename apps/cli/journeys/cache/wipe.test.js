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
  const before = await boardAnswers(board);
  assert.equal(before.show.code, 0, before.show.out);
  assert.ok(before.selection.inputKey, 'the selection answer names the test file by its input key');
  assert.ok(cacheFiles(board).length >= 4, 'the machine home and the runner root hold cache files before the wipe');
  wipeCaches(board);
  assert.deepEqual(cacheFiles(board), [], 'the wipe removed every cache file');
  assert.deepEqual(await boardAnswers(board), before, 'a cache was a second source of truth if any answer changed');
});
