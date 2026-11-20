/** A plain Python unittest project on a scratch board: a submitted failing test is refused red and the refusal names it [C7,#10559,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { BROKEN } from '../../tests/fixtures/languages/python.js';
import { PYTHON } from '../../tests/fixtures/languages/python.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/python.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/python.js';
import { pythonBoard } from '../../tests/fixtures/languages/python.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-python-red.a-submitted-commit-with-a-failing: clause 2: a submitted commit with a failing unittest case is refused red and the refusal names the test [C7,#10559]', { timeout: 240_000 }, async (t) => {
  if (!PYTHON) return t.skip(UNAVAILABLE);
  const board = await pythonBoard(helpers);
  const red = await buildAndSubmit(board, null, BROKEN);
  assert.match(red.shown.out, /GATE_RED/u, red.text);
  assert.match(red.text, /test_adds_small_numbers/u);
});
