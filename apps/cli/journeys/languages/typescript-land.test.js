/** A TypeScript npm project on a scratch board: the fixed commit passes the gate, is accepted and lands [C7,#10569,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { PASSING } from '../../tests/fixtures/languages/typescript.js';
import { TYPESCRIPT } from '../../tests/fixtures/languages/typescript.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/typescript.js';
import { acceptAndLand } from '../../tests/fixtures/languages/typescript.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/typescript.js';
import { typescriptBoard } from '../../tests/fixtures/languages/typescript.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-typescript-land.the-fixed-commit-passes-npm-test: clause 3: the fixed commit passes npm test on its .ts files, is accepted and lands on the scratch board main [C7,#10569]', { timeout: 240_000 }, async (t) => {
  if (!TYPESCRIPT) return t.skip(UNAVAILABLE);
  const board = await typescriptBoard(helpers);
  const fixed = await buildAndSubmit(board, null, PASSING);
  assert.equal(fixed.status, 'submitted', fixed.text);
  const { landing, settled } = await acceptAndLand(board, fixed.item, fixed.commit);
  assert.deepEqual(settled.landed, [Number(fixed.item)], `${landing.out}${landing.err}`);
  assert.equal(board.box.git(board.repo, 'show', 'main:test/item.test.ts'), PASSING.trimEnd());
});
