/** Existing non-launching test graphs remain browser-free while real Chrome work stays bound [C7,O5]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { testsNeedBrowser } from '../packages/gate/index.js';

test('clause 1: testkit fixture consumers keep browser-free admission when no browser launches [C7]', async () => {
  const root = join(import.meta.dirname, '..');
  for (const file of ['packages/blueprints/tests/blueprint.test.js', 'test/board-link.test.js', 'test/team-people.test.js']) {
    const reasons = [];
    assert.equal(await testsNeedBrowser(root, [file], { byLaunch: true, onFallback: why => reasons.push(why) }), false,
      file + ': ' + JSON.stringify(reasons));
  }
});

test('clause 2: a real Chrome fixture consumer retains browser admission [C7,O5]', async () => {
  assert.equal(await testsNeedBrowser(join(import.meta.dirname, '..'), ['test/chrome-fixture.test.js'], { byLaunch: true }), true);
});

test('clause 3: the three fixture consumers together stay browser-free while the matrix assertions hold [C7]', async () => {
  const root = join(import.meta.dirname, '..');
  const files = ['packages/blueprints/tests/blueprint.test.js', 'test/board-link.test.js', 'test/team-people.test.js'];
  assert.equal(await testsNeedBrowser(root, files, { byLaunch: true }), false);
});
