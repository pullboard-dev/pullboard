/** A plain Python unittest project on a scratch board: the fixed commit passes the gate, is accepted and lands [C7,#10559,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { PASSING } from '../../tests/fixtures/languages/python.js';
import { PYTHON } from '../../tests/fixtures/languages/python.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/python.js';
import { acceptAndLand } from '../../tests/fixtures/languages/python.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/python.js';
import { pythonBoard } from '../../tests/fixtures/languages/python.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-python-land.the-fixed-commit-passes-python3-m: clause 3: the fixed commit passes python3 -m unittest, is accepted and lands on the scratch board main [C7,#10559]', { timeout: 240_000 }, async (t) => {
  if (!PYTHON) return t.skip(UNAVAILABLE);
  const board = await pythonBoard(helpers);
  const fixed = await buildAndSubmit(board, null, PASSING);
  assert.equal(fixed.status, 'submitted', fixed.text);
  const { landing, settled } = await acceptAndLand(board, fixed.item, fixed.commit);
  assert.deepEqual(settled.landed, [Number(fixed.item)], `${landing.out}${landing.err}`);
  assert.equal(board.box.git(board.repo, 'show', 'main:test_item.py'), PASSING.trimEnd());
});
