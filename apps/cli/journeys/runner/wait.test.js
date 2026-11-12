/** After the runner deadline a waiting gate prints its fallback state once per change, then a bounded heartbeat [C7,O5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEADLINE_HEARTBEAT_MS } from '../../../../packages/resources/src/io/runner/reasons.js';
import { runnerDeadlineLine } from '../../../../packages/resources/src/io/runner/reasons.js';
import { runnerDeadlineOutput } from '../../../../packages/resources/src/io/runner/reasons.js';

const deadline = branch => ({ at: Date.parse('2026-10-25T12:00:00Z'), branch, runners: [{ host: 'mini-1', reason: 'unavailable (GUI session required)' }] });
const wait = { runners: [{ host: 'mini-1', reason: 'busy', slots: { total: 2, free: 0 }, browser: { total: 1, free: 1 },
  holders: [{ agent: 'core-9', item: 12, browser: false, timing: false }] }], gui: false, browser: false, timing: false };

test('clause 1: a waiting gate prints its state once per change [C7]', () => {
  const memory = {};
  const lines = [];
  for (let poll = 0; poll < 300; poll += 1) lines.push(...runnerDeadlineOutput(memory, deadline('local priority'), wait, poll * 200));
  assert.deepEqual(lines, [runnerDeadlineLine(deadline('local priority'))], 'hundreds of unchanged polls inside a minute print the state once');
  const changed = runnerDeadlineOutput(memory, deadline('GUI host unavailable'), wait, 60_000);
  assert.deepEqual(changed, [runnerDeadlineLine(deadline('GUI host unavailable'))], 'a changed state prints at once');
});

test('a waiting gate prints its state once per change, then one heartbeat a minute that says what it leaves out [C7]', () => {
  const memory = {};
  const lines = [];
  for (let poll = 0; poll <= 120; poll += 1) lines.push(...runnerDeadlineOutput(memory, deadline('local priority'), wait, poll * 1000));
  assert.equal(lines.length, 3, 'the state, then one heartbeat at 60 s and one at 120 s');
  assert.match(lines[1], /^still past the runner deadline; runner wait: .*mini-1: busy, gate 0\/2 free.*core-9 #12.*; 60 unchanged polls not printed$/u);
  assert.ok(DEADLINE_HEARTBEAT_MS >= 60_000);
});
