/** A C++ CMake project goes through init, add, claim, commit, submit, the ctest gate and land on a scratch board [C7,#10515,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { BROKEN } from '../../tests/fixtures/languages/cpp.js';
import { CHECK } from '../../tests/fixtures/languages/cpp.js';
import { CMAKE } from '../../tests/fixtures/languages/cpp.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/cpp.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/cpp.js';
import { cmakeBoard } from '../../tests/fixtures/languages/cpp.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-cpp-red.a-submitted-commit-with-a-failing: clause 2: a submitted commit with a failing ctest case is refused red and the refusal names the case [C7,#10515]', { timeout: 240_000 }, async (t) => {
  if (!CMAKE) return t.skip(UNAVAILABLE);
  const board = await cmakeBoard(helpers);
  const red = await buildAndSubmit(board, null, BROKEN);
  assert.match(red.shown.out, /GATE_RED/u, red.text);
  assert.doesNotMatch(CHECK, /adds_small_numbers/u);
  assert.match(red.text, /adds_small_numbers/u);
});
