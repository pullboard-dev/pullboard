/** A C-only CMake project compiled with cc goes through init, add, claim, commit, submit, the ctest gate and land on a scratch board [C7,#10780,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { BROKEN } from '../../tests/fixtures/languages/c.js';
import { CHECK } from '../../tests/fixtures/languages/c.js';
import { CMAKE } from '../../tests/fixtures/languages/c.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/c.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/c.js';
import { cmakeBoard } from '../../tests/fixtures/languages/c.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-c-red.a-failing-c-test-is-refused-naming-it: clause 2: a submitted commit with a failing C ctest case is refused red and the refusal names the case [C7,#10780]', { timeout: 240_000 }, async (t) => {
  if (!CMAKE) return t.skip(UNAVAILABLE);
  const board = await cmakeBoard(helpers);
  const red = await buildAndSubmit(board, null, BROKEN);
  assert.match(red.shown.out, /GATE_RED/u, red.text);
  assert.doesNotMatch(CHECK, /adds_small_numbers/u);
  assert.match(red.text, /adds_small_numbers/u);
});
