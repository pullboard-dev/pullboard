/** Private-child progress waits retain liveness and hang controls [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForFixtureProgress } from './fixture-progress.js';

test('a progressing fixture may cross the old total deadline [C7]', async () => {
  let clock = 0;
  await waitForFixtureProgress({
    child: { exitCode: null, signalCode: null },
    ready: () => clock >= 60_000,
    progress: () => Math.floor(clock / 10_000),
    description: 'progressing fixture',
    now: () => clock,
    pause: async () => {
      clock += 5_000;
      assert.ok(clock <= 60_000, 'the ready handshake must end the wait');
    },
  });
  assert.equal(clock, 60_000);
});

test('a parallel CLI may spend more than one old wait window before its real gate enters [B3,V4,Q1,Q3]', async () => {
  let clock = 0;
  let ready = false;
  let progress = 0;
  await waitForFixtureProgress({
    child: { exitCode: null, signalCode: null },
    ready: () => ready,
    progress: () => progress,
    description: 'the parallel CLI entered its real gate',
    quietMs: 120_000,
    now: () => clock,
    pause: async () => {
      clock += 10_000;
      if (clock === 80_000) progress++;
      if (clock === 150_000) ready = true;
      assert.ok(clock <= 150_000, 'the wait ends only after the real gate entry');
    },
  });
  assert.equal(clock, 150_000);
});

test('an alive fixture with no progress fails at the quiet window [C7]', async () => {
  let clock = 0;
  await assert.rejects(waitForFixtureProgress({
    child: { exitCode: null, signalCode: null },
    ready: () => false,
    progress: () => 0,
    description: 'stalled fixture',
    now: () => clock,
    pause: async () => {
      clock += 5_000;
      assert.ok(clock <= 20_000, 'a stalled wait must stop at its quiet window');
    },
  }), /stalled fixture: child made no progress for 20000 ms/u);
  assert.equal(clock, 20_000);
});

test('an exited fixture fails before the quiet window [C7]', async () => {
  let clock = 0;
  const child = { exitCode: null, signalCode: null };
  await assert.rejects(waitForFixtureProgress({
    child,
    ready: () => false,
    progress: () => 0,
    description: 'exited fixture',
    now: () => clock,
    pause: async () => {
      clock += 5_000;
      assert.equal(clock, 5_000, 'an exited child must not wait for another poll');
      child.exitCode = 7;
    },
  }), /exited fixture: child exited \(code 7, signal null\)/u);
  assert.equal(clock, 5_000);
});
