/** One real runner round trip, profiled by phase, and a repeat of the same tree held to a controller budget [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROFILE_LOG } from '../../tests/fixtures/runner/phases.js';
import { profiledRoundTrips } from '../../tests/fixtures/runner/phases.js';

test('a runner round trip names each controller phase, and a repeat of an unchanged tree beside four other jobs spends under 20 s there [C7]', {
  timeout: 400_000, // budget: two real worker-capsule round trips through the SSH stand-in, with verified cleanup.
}, async t => {
  const [first, repeat] = await profiledRoundTrips(t, 2, { otherJobs: 4 });
  assert.fail(`PROFILE ${first.line} || ${repeat.line} || ${PROFILE_LOG.join(' || ')}`);
  for (const name of ['launch', 'prepare', 'enqueue', 'collect']) {
    assert.ok(Number.isSafeInteger(first.phases.find(phase => phase.name === name).ms), `the profile times the controller's ${name} phase`);
  }
  assert.ok(repeat.controllerMs < 20_000, `a repeat of an unchanged tree beside four other jobs spends under 20 s on the controller side: ${repeat.line}`);
});
