/** pullboard land by hand on a board with automatic landing explains the change and names landing.manualOverride [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('clause 1: a hand land refuses BOARD_LANDS_ACCEPTED saying landing starts by itself after accept, and next: names landing.manualOverride [C7]', async () => {
  const box = helpers.project();
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  delete config.landing.manualOverride;
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: the board owns landing');
  const ran = await box.runLocal(box.repo, 'land', '--json');
  const error = JSON.parse(ran.out)?.error;
  assert.equal(error?.code, 'BOARD_LANDS_ACCEPTED', ran.out + ran.err);
  assert.match(error.message, /the board lands accepted items by itself/u);
  assert.match(error.message, /landing starts on its own/u);
  assert.match(error.next, /landing\.manualOverride/u);
});
