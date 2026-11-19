/** A plain C# dotnet project on a scratch board: the fixed commit passes the gate, is accepted and lands [C7,#10675,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { DOTNET } from '../../tests/fixtures/languages/csharp.js';
import { PASSING } from '../../tests/fixtures/languages/csharp.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/csharp.js';
import { acceptAndLand } from '../../tests/fixtures/languages/csharp.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/csharp.js';
import { dotnetBoard } from '../../tests/fixtures/languages/csharp.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-csharp-land.the-fixed-dotnet-commit-lands: clause 3: the fixed commit passes dotnet test, is accepted and lands on the scratch board main [C7,#10675]', { timeout: 240_000 }, async (t) => {
  if (!DOTNET) return t.skip(UNAVAILABLE);
  const board = await dotnetBoard(helpers);
  const fixed = await buildAndSubmit(board, null, PASSING);
  assert.equal(fixed.status, 'submitted', fixed.text);
  const { landing, settled } = await acceptAndLand(board, fixed.item, fixed.commit);
  assert.deepEqual(settled.landed, [Number(fixed.item)], `${landing.out}${landing.err}`);
  assert.equal(board.box.git(board.repo, 'show', 'main:ItemTests.cs'), PASSING.trimEnd());
});
