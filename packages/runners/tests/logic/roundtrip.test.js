/** The round-trip profile names every phase, splits controller from runner time, and never guesses a missing mark [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROUND_TRIP_PHASES } from '../../src/logic/roundtrip.js';
import { roundTripLine } from '../../src/logic/roundtrip.js';
import { roundTripProfile } from '../../src/logic/roundtrip.js';

const MARKS = { dispatch: 0, prepare: 400, prepared: 1_400, submitted: 1_700, need: 2_700, 'source-sent': 3_000, ready: 4_000, done: 9_000, end: 9_600 };

test('runners.roundtrip.a-pulled-round-trip-is-timed: a pulled round trip is timed phase by phase, controller and runner apart [C7]', () => {
  const profile = roundTripProfile(MARKS);
  assert.deepEqual(profile.phases.map(phase => [phase.name, phase.ms]),
    [['launch', 400], ['prepare', 1_000], ['enqueue', 300], ['need', 1_000], ['transfer', 300], ['checkout', 1_000], ['run', 5_000], ['collect', 600]]);
  assert.equal(profile.controllerMs, 400 + 1_000 + 300 + 300 + 600);
  assert.equal(profile.runnerMs, 1_000 + 1_000 + 5_000);
  assert.equal(profile.totalMs, 9_600);
  assert.equal(profile.controllerMs + profile.runnerMs, profile.totalMs, 'the phases cover the whole trip with no gap');
  assert.match(roundTripLine(profile), /^round trip: \*launch 0\.4s, \*prepare 1\.0s, \*enqueue 0\.3s, need 1\.0s, \*transfer 0\.3s, checkout 1\.0s, run 5\.0s, \*collect 0\.6s; controller 2\.6s, total 9\.6s$/u);
});

test('runners.roundtrip.a-trip-whose-runner-already-held: a trip whose runner already held the source has no transfer, and its checkout runs from the enqueue [C7]', () => {
  const { need, 'source-sent': sent, ...held } = MARKS;
  const profile = roundTripProfile(held);
  assert.equal(profile.phases.find(phase => phase.name === 'transfer').ms, null);
  assert.equal(profile.phases.find(phase => phase.name === 'need').ms, null);
  assert.equal(profile.phases.find(phase => phase.name === 'checkout').ms, 4_000 - 1_700);
  assert.equal(profile.controllerMs + profile.runnerMs, profile.totalMs);
});

test('runners.roundtrip.missing-or-backward-marks-time-nothing: missing or backward marks time nothing rather than a guess [C7]', () => {
  const profile = roundTripProfile({ dispatch: 0, prepare: 500, prepared: 100 });
  assert.equal(profile.phases.find(phase => phase.name === 'launch').ms, 500);
  assert.equal(profile.phases.find(phase => phase.name === 'prepare').ms, null, 'a mark before its start is not a negative time');
  assert.equal(profile.totalMs, null);
  assert.equal(roundTripProfile(null).controllerMs, 0);
  assert.deepEqual(ROUND_TRIP_PHASES.filter(phase => phase.side === 'controller').map(phase => phase.name), ['launch', 'prepare', 'enqueue', 'transfer', 'collect']);
});
