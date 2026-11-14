/** Capture cleanup leaves no detached automatic lander behind [C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** The commands of every live process that runs the automatic lander for a path under `dir`. */
function landers(dir) {
  const listed = runFixtureChild('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.failure ?? listed.stderr);
  return listed.stdout.split('\n').filter(line => line.includes('/landing/automatic.js') && line.includes(dir));
}

test('a captured session leaves no detached automatic.js process once its fixture is cleaned up [C7]', () => {
  const box = helpers.project();
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Capture fixture item' });
  for (const args of [['next', '--json'], ['status'], ['show', '1']]) box.run(box.repo, ...args);
  assert.deepEqual(landers(box.dir), [], 'the commands a capture runs start no automatic lander');
  helpers.cleanup();
  assert.deepEqual(landers(box.dir), [], 'cleanup leaves no automatic lander for the removed fixture');
});
