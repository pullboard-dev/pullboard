/** A plain pytest project on a scratch board: a submitted failing test is refused red and the refusal names it [C7,#10616,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { BROKEN } from '../../tests/fixtures/languages/pytest.js';
import { PYTEST } from '../../tests/fixtures/languages/pytest.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/pytest.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/pytest.js';
import { pytestBoard } from '../../tests/fixtures/languages/pytest.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-pytest-red.a-failing-pytest-test-is-refused-naming-it: clause 2: a submitted commit with a failing pytest test is refused red and the refusal names the test [C7,#10616]', { timeout: 240_000 }, async (t) => {
  if (!PYTEST) return t.skip(UNAVAILABLE);
  const board = await pytestBoard(helpers);
  const red = await buildAndSubmit(board, null, BROKEN);
  assert.match(red.shown.out, /GATE_RED/u, red.text);
  assert.match(red.text, /test_adds_small_numbers/u);
});
