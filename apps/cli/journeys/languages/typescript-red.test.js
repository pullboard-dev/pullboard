/** A TypeScript npm project on a scratch board: a submitted failing test is refused red and the refusal names it [C7,#10569,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { BROKEN } from '../../tests/fixtures/languages/typescript.js';
import { TYPESCRIPT } from '../../tests/fixtures/languages/typescript.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/typescript.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/typescript.js';
import { typescriptBoard } from '../../tests/fixtures/languages/typescript.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-typescript-red.a-submitted-commit-with-a-failing: clause 2: a submitted commit with a failing TypeScript test is refused red and the refusal names the test [C7,#10569]', { timeout: 240_000 }, async (t) => {
  if (!TYPESCRIPT) return t.skip(UNAVAILABLE);
  const board = await typescriptBoard(helpers);
  const red = await buildAndSubmit(board, null, BROKEN);
  assert.match(red.shown.out, /GATE_RED/u, red.text);
  assert.match(red.text, /adds_small_numbers/u);
});
