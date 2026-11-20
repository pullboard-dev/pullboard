/** A plain PHP composer project on a scratch board: a submitted failing test is refused red and the refusal names it [C7,#10618,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { BROKEN } from '../../tests/fixtures/languages/php.js';
import { COMPOSER } from '../../tests/fixtures/languages/php.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/php.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/php.js';
import { composerBoard } from '../../tests/fixtures/languages/php.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-php-red.a-failing-phpunit-test-is-refused-naming-it: clause 2: a submitted commit with a failing phpunit test is refused red and the refusal names the test [C7,#10618]', { timeout: 240_000 }, async (t) => {
  if (!COMPOSER) return t.skip(UNAVAILABLE);
  const board = await composerBoard(helpers);
  const red = await buildAndSubmit(board, null, BROKEN);
  assert.match(red.shown.out, /GATE_RED/u, red.text);
  assert.match(red.text, /testAddsSmallNumbers/u);
});
