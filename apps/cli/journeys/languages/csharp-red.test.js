/** A plain C# dotnet project on a scratch board: a submitted failing test is refused red and the refusal names it [C7,#10675,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { BROKEN } from '../../tests/fixtures/languages/csharp.js';
import { DOTNET } from '../../tests/fixtures/languages/csharp.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/csharp.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/csharp.js';
import { dotnetBoard } from '../../tests/fixtures/languages/csharp.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-csharp-red.a-failing-xunit-test-is-refused-naming-it: clause 2: a submitted commit with a failing xunit test is refused red and the refusal names the test [C7,#10675]', { timeout: 240_000 }, async (t) => {
  if (!DOTNET) return t.skip(UNAVAILABLE);
  const board = await dotnetBoard(helpers);
  const red = await buildAndSubmit(board, null, BROKEN);
  assert.match(red.shown.out, /GATE_RED/u, red.text);
  assert.match(red.text, /AddsSmallNumbers/u);
});
