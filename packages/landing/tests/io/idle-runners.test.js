/** @pullboard-test-input source-cell landing */
/** The idle-runner tick calls recoverIdleRunners on its interval and never lets a slow probe delay the tick [C7,#8325]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idleRunnerTick } from '../../src/io/idle-runners.js';

/** Stub ports whose recoverIdleRunners records its calls and runs the given body. */
function ports(runners, body = async () => false) {
  const calls = [];
  return { calls, load: async () => ({ runners: () => runners, probes: { probe: () => {}, transportProbe: () => {} },
    recoverIdleRunners: async (...args) => { calls.push(args); return body(); } }) };
}

test('landing.idle-runners.the-resident-tick-calls-recoveridlerunners-for: clause 1: the resident tick calls recoverIdleRunners for a configured runner when its interval is due and no gate is waiting [C7,#8325]', async () => {
  let now = 0;
  const { calls, load } = ports([{ host: 'quarantined-runner' }]);
  const tick = idleRunnerTick({ settings: () => ({}), clock: () => now, intervalMs: 1_000, load });
  assert.equal(tick(), null, 'the first pass waits one interval');
  now = 1_000;
  await tick();
  assert.equal(calls.length, 1, 'a due tick probes');
  assert.deepEqual(calls[0][0], [{ host: 'quarantined-runner' }]);
  assert.equal(typeof calls[0][1].probe, 'function', 'the probes travel inside the options');
  assert.equal(typeof calls[0][1].now, 'number');
  now = 1_500;
  assert.equal(tick(), null, 'a tick inside the interval does nothing');
  now = 2_000;
  await tick();
  assert.equal(calls.length, 2);
});

test('landing.idle-runners.a-slow-probe-never-delays-the: clause 2: a slow probe never delays the resident tick past its interval [C7,#8325]', async () => {
  let now = 0;
  let release;
  const { calls, load } = ports([{ host: 'slow-runner' }], () => new Promise(done => { release = done; }));
  const tick = idleRunnerTick({ settings: () => ({}), clock: () => now, intervalMs: 1_000, load });
  now = 1_000;
  const pass = tick();
  assert.ok(pass, 'the pass starts, and the tick returned while the probe is still waiting to be released');
  await new Promise(done => setImmediate(done));
  assert.equal(calls.length, 1);
  now = 5_000;
  assert.equal(tick(), null, 'while a probe runs, later ticks return at once and start no second pass');
  release();
  await pass;
  now = 6_000;
  const second = tick();
  await new Promise(done => setImmediate(done));
  assert.equal(calls.length, 2, 'the next interval after the slow probe probes again');
  release();
  await second;
});

test('landing.idle-runners.a-failing-pass-is-swallowed-and: clause 1: a failing pass is swallowed and a runnerless machine makes no call [C7,#8325]', async () => {
  let now = 0;
  const failing = ports([{ host: 'r' }], async () => { throw new Error('queue locked'); });
  const tick = idleRunnerTick({ settings: () => ({}), clock: () => now, intervalMs: 10, load: failing.load });
  now = 10;
  await tick();
  const none = ports([]);
  const quiet = idleRunnerTick({ settings: () => ({}), clock: () => now, intervalMs: 10, load: none.load });
  now = 20;
  await quiet();
  assert.equal(none.calls.length, 0);
});
