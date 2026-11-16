/**
 * End to end on real repos: hold pauses a lane (N22).
 */
/** @pullboard-test-input source-cell apps/cli apps/lib store */

import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project } = e2e;

test('hold pauses a lane: next names who held it and why; --off lets it go [N22]', async () => {
  const box = project();
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1');
  assert.match((await box.runLocal(box.web, 'hold', 'web', '--reason', 'mine')).err, /COORDINATOR_ONLY/);
  assert.match((await box.runLocal(box.repo, 'hold', 'nowhere', '--reason', 'x')).err, /NO_LANE/);
  assert.match((await box.runLocal(box.repo, 'hold', 'web', '--reason', 'G1 is being rewritten')).out, /holding the web lane: G1 is being rewritten/);
  const held = (await box.runLocal(box.web, 'next', '--take'));
  assert.equal(held.code, 1);
  assert.match(held.err, /coordinator \(unknown\) holds the web lane: G1 is being rewritten/);
  assert.match((await box.runLocal(box.web, 'claim', '1')).err, /LANE_HELD/);
  assert.match((await box.runLocal(box.web, 'resume')).out, /the web lane is held by coordinator \(unknown\): G1 is being rewritten/);
  assert.match((await box.runLocal(box.repo, 'hold', 'web', '--off')).out, /released the web lane/);
  assert.match((await box.runLocal(box.web, 'next')).out, /claimed #1: Page/);
});
