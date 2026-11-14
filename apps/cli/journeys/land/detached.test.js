/** Capture cleanup leaves no detached automatic lander behind [C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { landers } from '../../tests/fixtures/land/landers.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('a captured session leaves no detached automatic.js process once its fixture is cleaned up [C7]', async () => {
  const box = helpers.project();
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Capture fixture item' });
  for (const args of [['next', '--json'], ['status'], ['show', '1']]) await box.runLocal(box.repo, ...args);
  assert.deepEqual(landers(box.dir), [], 'the commands a capture runs start no automatic lander');
  helpers.cleanup();
  assert.deepEqual(landers(box.dir), [], 'cleanup leaves no automatic lander for the removed fixture');
});
