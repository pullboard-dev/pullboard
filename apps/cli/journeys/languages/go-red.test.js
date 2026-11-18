/** A plain Go module on a scratch board: a submitted failing test is refused red and the refusal names it [C7,#10612,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { BROKEN } from '../../tests/fixtures/languages/go.js';
import { GO } from '../../tests/fixtures/languages/go.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/go.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/go.js';
import { goBoard } from '../../tests/fixtures/languages/go.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-go-red.a-failing-go-test-is-refused-naming-it: clause 2: a submitted commit with a failing go test is refused red and the refusal names the test [C7,#10612]', { timeout: 240_000 }, async (t) => {
  if (!GO) return t.skip(UNAVAILABLE);
  const board = await goBoard(helpers);
  const red = await buildAndSubmit(board, null, BROKEN);
  assert.match(red.shown.out, /GATE_RED/u, red.text);
  assert.match(red.text, /TestAddsSmallNumbers/u);
});
