/** @pullboard-test-input packages/landing/index.js */
/** A landing gate red only on runner refusals is a landing fault that retries, never a diagnosis or a park [C7,#3693]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runnerRefusalOnly,
  requireNoRunnerRefusalOnlyRed,
} from '../../../../../packages/landing/index.js';
import { repeatedBlockedCause } from '../../../../../packages/landing/index.js';
import { retryableLandingRefusal } from '../../../../../packages/landing/index.js';
import { landingFault } from '../../../../../packages/landing/index.js';

/** The shape of #2550's candidate-1.log (batch bc96678a): one shard refused twice, the rest green or stopped. */
const REFUSED_SHARDS = [
  '# landing shards: 2 balanced by history and average (1/2 1 files, 2/2 1 files)',
  'landing shard 2/2: runner fixture-a refused it: [SLOT_DB_LOCKED] never ran: the resource queue stayed locked for 10011ms; retry when the writer finishes',
  '# landing shard 2/2 attempt 1 on fixture-a: refused (runner refused: SLOT_DB_LOCKED) in 47 ms',
  'landing shard 2/2: runner fixture-a refused (runner refused: SLOT_DB_LOCKED); queuing shard 2/2 again (attempt 2)',
  '# landing shard 1/2 attempt 1 on fixture-b: green in 55 ms',
];
const STOPPED = [
  '# landing shard 2/2 attempt 2 on fixture-c: stopped in 44 ms',
  'run-tests: [SLOT_DB_LOCKED] never ran: the resource queue database stayed locked for 10015ms; retry when the writer finishes',
];

test('a gate log whose only non-green shards are runner refusals names their codes; any decided red names none [C7,#3693]', () => {
  const tap = ['TAP version 13', '# Subtest: kept', 'ok 1 - kept', '1..1', '# tests 1', '# pass 1', '# fail 0'];
  assert.deepEqual(runnerRefusalOnly([...REFUSED_SHARDS, ...tap, ...STOPPED].join('\n')), ['SLOT_DB_LOCKED']);
  assert.deepEqual(runnerRefusalOnly(['# landing shard 1/1 attempt 1 on h: infrastructure (runner transport lost) in 9 ms', ...tap].join('\n')), ['RUNNER_TRANSPORT_LOST']);
  const red = ['# Subtest: broken', 'not ok 2 - broken', '# fail 1'];
  assert.equal(runnerRefusalOnly([...REFUSED_SHARDS, ...red, ...STOPPED].join('\n')), null, 'a real failing case is never a fault');
  assert.equal(runnerRefusalOnly([...REFUSED_SHARDS, '# landing shard 1/2 attempt 1 on h: red in 9 ms'].join('\n')), null, 'a red shard decides');
  assert.equal(runnerRefusalOnly(['# landing shard 1/1 attempt 1 on local: refused (landing refused: LANDING_SOURCE_CHANGED) in 0 ms', 'run-tests: [SLOT_DB_LOCKED] never ran'].join('\n')), null, 'a changed source is not a runner fault');
  assert.equal(runnerRefusalOnly(tap.join('\n')), null, 'a red with no runner refusal stays a diagnosis');
  const log = [...REFUSED_SHARDS, ...tap, ...STOPPED].join('\n');
  assert.throws(() => requireNoRunnerRefusalOnlyRed({ isGreen: false, failures: [], logPath: 'x.log' }, () => log),
    error => error.code === 'LAND_RUNNER_FAULT' && landingFault(error) && retryableLandingRefusal(error.code));
  assert.doesNotThrow(() => requireNoRunnerRefusalOnlyRed({ isGreen: false, failures: [{ file: 'a.test.js', name: 'n' }], logPath: 'x.log' }, () => log));
  assert.doesNotThrow(() => requireNoRunnerRefusalOnlyRed({ isGreen: false, timedOut: true, failures: [], logPath: 'x.log' }, () => log));
});

test('the repeat guard never parks on a landing fault and still parks on a repeated diagnosis [C7,#3693]', () => {
  const item = { item_id: 7, item_commit: 'c'.repeat(40) };
  const batch = (id, code) => ({ id, state: 'blocked', base: 'b'.repeat(40), items: [{ id: 7, commit: item.item_commit }], refusal: { code, message: code } });
  for (const code of ['LAND_RUNNER_FAULT', 'SLOT_DB_LOCKED', 'BOARD_BUSY']) assert.equal(repeatedBlockedCause([batch('a', code), batch('b', code)], item), null, code);
  assert.equal(repeatedBlockedCause([batch('a', 'LAND_DIAGNOSTIC'), batch('b', 'LAND_DIAGNOSTIC')], item)?.key, 'LAND_DIAGNOSTIC');
});
