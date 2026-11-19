/** A plain PHP composer project on a scratch board: the fixed commit passes the gate, is accepted and lands [C7,#10618,#3705]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { COMPOSER } from '../../tests/fixtures/languages/php.js';
import { PASSING } from '../../tests/fixtures/languages/php.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/php.js';
import { acceptAndLand } from '../../tests/fixtures/languages/php.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/php.js';
import { composerBoard } from '../../tests/fixtures/languages/php.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-php-land.the-fixed-composer-commit-lands: clause 3: the fixed commit passes composer test, is accepted and lands on the scratch board main [C7,#10618]', { timeout: 240_000 }, async (t) => {
  if (!COMPOSER) return t.skip(UNAVAILABLE);
  const board = await composerBoard(helpers);
  const fixed = await buildAndSubmit(board, null, PASSING);
  assert.equal(fixed.status, 'submitted', fixed.text);
  const { landing, settled } = await acceptAndLand(board, fixed.item, fixed.commit);
  assert.deepEqual(settled.landed, [Number(fixed.item)], `${landing.out}${landing.err}`);
  assert.equal(board.box.git(board.repo, 'show', 'main:tests/ItemTest.php'), PASSING.trimEnd());
});
