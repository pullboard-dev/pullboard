/** A landing's gate says its runner wait and its tests as separate phase lines [C7,B3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PHASE_LINE } from '../../src/io/timing.js';
import { sayGateSplit } from '../../src/io/timing.js';

test('landing.gate-phases.a-gate-job-queued-at-1000: clause 1: a gate job queued at 1000 and claimed at 4500 says a runner wait of 3500 ms [C7,B3]', () => {
  const lines = [];
  sayGateSplit(line => lines.push(line), { queuedAt: 1000, claimedAt: 4500, resultAt: 9000 });
  assert.equal(lines[0], 'landing phase runner wait: 3500 ms');
});

test('landing.gate-phases.the-same-gate-says-tests-from: clause 2: the same gate says tests from the claim to the recorded result, 4500 ms [C7,B3]', () => {
  const lines = [];
  const said = sayGateSplit(line => lines.push(line), { queuedAt: 1000, claimedAt: 4500, resultAt: 9000 });
  assert.equal(lines[1], 'landing phase tests: 4500 ms');
  assert.deepEqual(said, [{ phase: 'runner wait', ms: 3500 }, { phase: 'tests', ms: 4500 }]);
  const none = [];
  sayGateSplit(line => none.push(line), { queuedAt: 1000 });
  assert.deepEqual(none, [], 'missing marks say nothing');
});

test('landing.gate-phases.phase-line-matches-both-new-lines: clause 3: PHASE_LINE matches both new lines and still the old ones [C7,B3]', () => {
  const lines = [];
  sayGateSplit(line => lines.push(line), { queuedAt: 0, claimedAt: 10, resultAt: 30 });
  for (const line of lines) assert.match(line, PHASE_LINE);
  assert.deepEqual(PHASE_LINE.exec(lines[1]).slice(1), ['tests', '20']);
  assert.match('landing phase gate: 5 ms', PHASE_LINE);
});
