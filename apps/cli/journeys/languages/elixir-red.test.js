/** A plain Elixir mix project on a scratch board: a submitted failing test is refused red and the refusal names it [C7,#10619,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { BROKEN } from '../../tests/fixtures/languages/elixir.js';
import { MIX } from '../../tests/fixtures/languages/elixir.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/elixir.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/elixir.js';
import { mixBoard } from '../../tests/fixtures/languages/elixir.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-elixir-red.a-failing-exunit-test-is-refused-naming-it: clause 2: a submitted commit with a failing ExUnit test is refused red and the refusal names the test [C7,#10619]', { timeout: 240_000 }, async (t) => {
  if (!MIX) return t.skip(UNAVAILABLE);
  const board = await mixBoard(helpers);
  const red = await buildAndSubmit(board, null, BROKEN);
  assert.match(red.shown.out, /GATE_RED/u, red.text);
  assert.match(red.text, /adds small numbers/u);
});
