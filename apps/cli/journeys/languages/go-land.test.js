/** A plain Go module on a scratch board: the fixed commit passes the gate, is accepted and lands [C7,#10612,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { GO } from '../../tests/fixtures/languages/go.js';
import { PASSING } from '../../tests/fixtures/languages/go.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/go.js';
import { acceptAndLand } from '../../tests/fixtures/languages/go.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/go.js';
import { goBoard } from '../../tests/fixtures/languages/go.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-go-land.the-fixed-go-commit-lands: clause 3: the fixed commit passes go test ./..., is accepted and lands on the scratch board main [C7,#10612]', { timeout: 240_000 }, async (t) => {
  if (!GO) return t.skip(UNAVAILABLE);
  const board = await goBoard(helpers);
  const fixed = await buildAndSubmit(board, null, PASSING);
  assert.equal(fixed.status, 'submitted', fixed.text);
  const { landing, settled } = await acceptAndLand(board, fixed.item, fixed.commit);
  assert.deepEqual(settled.landed, [Number(fixed.item)], `${landing.out}${landing.err}`);
  assert.equal(board.box.git(board.repo, 'show', 'main:item_test.go'), PASSING.trimEnd());
});
