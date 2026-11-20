/** A C-only CMake project compiled with cc goes through init, add, claim, commit, submit, the ctest gate and land on a scratch board [C7,#10780,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { CMAKE } from '../../tests/fixtures/languages/c.js';
import { PASSING } from '../../tests/fixtures/languages/c.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/c.js';
import { acceptAndLand } from '../../tests/fixtures/languages/c.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/c.js';
import { cmakeBoard } from '../../tests/fixtures/languages/c.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-c-land.the-fixed-c-commit-lands: clause 3: the fixed C commit passes ctest, is accepted and lands on the scratch board main [C7,#10780]', { timeout: 240_000 }, async (t) => {
  if (!CMAKE) return t.skip(UNAVAILABLE);
  const board = await cmakeBoard(helpers);
  const fixed = await buildAndSubmit(board, null, PASSING);
  assert.equal(fixed.status, 'submitted', fixed.text);
  const { landing, settled } = await acceptAndLand(board, fixed.item, fixed.commit);
  assert.deepEqual(settled.landed, [Number(fixed.item)], `${landing.out}${landing.err}`);
  assert.equal(board.box.git(board.repo, 'show', 'main:tests/item_test.c'), PASSING.trimEnd());
});
