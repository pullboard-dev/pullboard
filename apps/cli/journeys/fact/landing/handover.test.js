/** @pullboard-test-input apps/cli/src/io/landing/automatic.js */
/** A lander whose code is older than main's names the change in a reason that fits the landing_lease event [C7,#3467]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staleLanderReason } from '../../../src/io/landing/automatic.js';

test('a stale lander reason names both code commits and fits the landing_lease event [C7,#3467]', () => {
  const loaded = 'a'.repeat(40), current = 'b'.repeat(40);
  const reason = staleLanderReason(loaded, current);
  assert.match(reason, /^lander code a{12} is older than main's b{12} \(apps\/cli\/src\/io\/landing\/automatic\.js, packages\/landing\)$/u);
  assert.ok(reason.length <= 120, 'the lease event keeps 120 characters of a reason');
  assert.equal(staleLanderReason(loaded, loaded), null, 'the same code is not stale');
  assert.equal(staleLanderReason(null, current), null, 'a lander that cannot read its code never hands over on a guess');
  assert.equal(staleLanderReason(loaded, null), null);
});
