/** A plain Elixir mix project on a scratch board: the fixed commit passes the gate, is accepted and lands [C7,#10619,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { MIX } from '../../tests/fixtures/languages/elixir.js';
import { PASSING } from '../../tests/fixtures/languages/elixir.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/elixir.js';
import { acceptAndLand } from '../../tests/fixtures/languages/elixir.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/elixir.js';
import { mixBoard } from '../../tests/fixtures/languages/elixir.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-elixir-land.the-fixed-mix-commit-lands: clause 3: the fixed commit passes mix test, is accepted and lands on the scratch board main [C7,#10619]', { timeout: 240_000 }, async (t) => {
  if (!MIX) return t.skip(UNAVAILABLE);
  const board = await mixBoard(helpers);
  const fixed = await buildAndSubmit(board, null, PASSING);
  assert.equal(fixed.status, 'submitted', fixed.text);
  const { landing, settled } = await acceptAndLand(board, fixed.item, fixed.commit);
  assert.deepEqual(settled.landed, [Number(fixed.item)], `${landing.out}${landing.err}`);
  assert.equal(board.box.git(board.repo, 'show', 'main:test/item_test.exs'), PASSING.trimEnd());
});
