/** A person's landing waiver wakes a backed-off lander at once, so a held trunk it releases lands without waiting [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingWakeTrigger } from '../index.js';

const held = { 'apps/cli/journeys/submit/merge.test.js': 'a'.repeat(40) };

test('clause 1: a waiver recorded during a back-off wakes the lander; nothing new keeps it asleep [C7]', () => {
  const before = { verified: ['3768:c1', '3489:c2'], held, waivers: 120 };
  assert.equal(landingWakeTrigger(before, { ...before, waivers: 131 }), 'waiver');
  assert.equal(landingWakeTrigger(before, { ...before }), null);
  // Marks recorded before waivers were counted never wake on their absence.
  assert.equal(landingWakeTrigger({ verified: before.verified, held }, { ...before, waivers: 131 }), null);
  // An accept still wakes first.
  assert.equal(landingWakeTrigger(before, { ...before, verified: [...before.verified, '3935:c3'], waivers: 131 }), 'verified');
});
