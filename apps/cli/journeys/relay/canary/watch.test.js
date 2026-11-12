/** Minute canary scheduling, cross-watch admission, shutdown draining and durable notice retry [H5,H17,C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  dirname,
  join,
} from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoInfo } from '../../../../../packages/git/index.js';
import { probeRelayCanary } from '../../../../../packages/link/index.js';
import { pendingRelayCanaryNotices } from '../../../../../packages/link/index.js';
import {
  startRelayCanaryWatch,
  RELAY_CANARY_INTERVAL_MS,
  runRelayCanary,
} from '../../../../../packages/link/index.js';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';

/** Capture the scheduler callback so cadence tests advance time without sleeping. */
function fakeInterval() {
  const timers = [];
  return {
    timers,
    every(callback, delay) {
      const timer = { callback, delay, unrefed: false, unref() { this.unrefed = true; } };
      timers.push(timer);
      return timer;
    },
    cancel(timer) { timer.cancelled = true; },
  };
}

/** Temporarily give a direct probe only a private fixture's machine paths and restore every parent value. */
async function withFixtureEnvironment(env, action) {
  const names = ['HOME', 'PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PATH'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) {
    if (Object.hasOwn(env, name)) process.env[name] = env[name];
    else delete process.env[name];
  }
  try { return await action(); }
  finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

/** Install the isolated Pullboard entry point; the fixture already committed its project configuration. */
function installPullboardEntry(box) {
  const cli = fileURLToPath(new URL('../../../pullboard.js', import.meta.url));
  const privateBin = box.env.PATH.split(delimiter)[0];
  const pullboard = join(privateBin, 'pullboard');
  assert.equal(existsSync(pullboard), false, 'the fixture has no preexisting private Pullboard wrapper to overwrite');
  writeFileSync(pullboard, `#!/bin/sh\nexec node "${cli}" "$@"\n`, { mode: 0o700 });
}

/** Create a real noncoordinator agent worktree sharing the fixture's local board and relay link. */
async function joinedCanarySeat(box) {
  const root = join(box.root, '..', 'watch-seat');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'agent/watch-canary', root], { cwd: box.root, env: box.env });
  const joined = await box.cliAtLocal(root, 'join', box.lane, '--model', 'watch-fixture');
  assert.equal(joined.code, 0, joined.failure);
  return { root, agentId: joined.document.agent };
}

test('the watch runs once per minute only while opted in [H5,H17]', { timeout: 45_000 }, async t => { // budget: private Git fixture setup and bounded CLI cleanup; cadence advances with a fake clock.
  const box = await relayClientFixture(t);
  const clock = fakeInterval();
  let now = 10_000;
  let calls = 0;
  const watch = startRelayCanaryWatch({
    config: () => ({ enabled: false, root: box.root, agentId: 'fixture-seat' }),
    run: async () => { calls += 1; }, now: () => now,
    every: clock.every, cancel: clock.cancel,
  });
  await watch.tick();
  assert.equal(calls, 0, 'an explicit off setting does not probe or claim a minute');
  assert.equal(existsSync(join(repoInfo(box.root).commonDir, 'pullboard', 'relay-health.sqlite')), false,
    'off configuration creates no canary schedule state');
  await watch.close();
  assert.equal(clock.timers[0].delay, RELAY_CANARY_INTERVAL_MS);
  assert.equal(clock.timers[0].unrefed, true, 'the minute timer does not keep the client alive');
  assert.equal(clock.timers[0].cancelled, true);

  const enabledClock = fakeInterval();
  const enabled = startRelayCanaryWatch({
    config: () => ({ enabled: true, root: box.root, agentId: 'fixture-seat' }),
    run: async () => { calls += 1; }, now: () => now,
    every: enabledClock.every, cancel: enabledClock.cancel,
  });
  await enabled.tick();
  assert.equal(calls, 1, 'the first enabled tick runs immediately');
  await enabledClock.timers[0].callback();
  assert.equal(calls, 1, 'a second tick inside the claimed minute is skipped');
  now += RELAY_CANARY_INTERVAL_MS;
  await enabledClock.timers[0].callback();
  assert.equal(calls, 2, 'the next due minute is admitted');
  await enabled.close();
});

test('same-root watches share atomic admission and close aborts and drains a single run [H5,H17]', { timeout: 45_000 }, async t => { // budget: private Git/SQLite setup and a manually released in-flight run; no polling delay.
  const box = await relayClientFixture(t);
  const clockA = fakeInterval();
  const clockB = fakeInterval();
  const now = 50_000;
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let signal;
  let releaseRun;
  let resolveStarted;
  let drained = false;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const held = new Promise(resolve => { releaseRun = resolve; });
  const run = async (_config, { io }) => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    signal = io.relaySignal;
    resolveStarted();
    await held;
    active -= 1;
    drained = true;
  };
  const config = () => ({ enabled: true, root: box.root, agentId: 'fixture-seat' });
  const first = startRelayCanaryWatch({ config, run, now: () => now, every: clockA.every, cancel: clockA.cancel });
  const second = startRelayCanaryWatch({ config, run, now: () => now, every: clockB.every, cancel: clockB.cancel });
  await started;
  // Trigger competing/repeated ticks without awaiting a potentially winning held run.
  const competingTick = second.tick();
  const repeatedTicks = [first.tick(), first.tick()];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'the shared SQLite minute claim admits one of two same-root watches');
  assert.equal(maximumActive, 1, 'repeated ticks never overlap the watch’s in-flight run');

  let closed = false;
  const closing = Promise.all([first.close(), second.close()]).then(() => { closed = true; });
  assert.equal(signal.aborted, true, 'closing the owning watch aborts the active probe signal');
  await Promise.resolve();
  assert.equal(closed, false, 'close waits for the active run to finish its cleanup');
  assert.equal(drained, false);
  releaseRun();
  await Promise.all([closing, competingTick, ...repeatedTicks]);
  assert.equal(drained, true);
  assert.equal(active, 0);

  const file = join(repoInfo(box.root).commonDir, 'pullboard', 'relay-health.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT id, next_due FROM canary_schedule').all().map(row => ({ ...row })), [{ id: 1, next_due: now + RELAY_CANARY_INTERVAL_MS }],
      'both watch processes use one durable SQLite schedule row');
  } finally { db.close(); }
});

test('a pending alert notice retries after delivery failure and is removed only after success [H5,H17]', { timeout: 60_000 }, async t => { // budget: linked loopback fixture, three bounded probes, and fixture cleanup.
  const box = await relayClientFixture(t);
  installPullboardEntry(box);
  await box.link();
  const seat = await joinedCanarySeat(box);
  await box.stopRelay();
  const config = { enabled: true, root: seat.root, agentId: seat.agentId, deadlineMs: 5_000 };
  let now = Date.now();
  const attemptIds = [];
  await withFixtureEnvironment(box.env, () => runRelayCanary(config, { io: apiBoardOpeners, now: () => now,
    notify: async notice => { attemptIds.push(notice.id); } }));

  now += 60_000;
  await assert.rejects(withFixtureEnvironment(box.env, () => runRelayCanary(config, { io: apiBoardOpeners, now: () => now,
    notify: async notice => { attemptIds.push(notice.id); throw new Error('fixture delivery failure'); } })), /fixture delivery failure/u);
  const pending = pendingRelayCanaryNotices(box.root);
  assert.equal(pending.length, 1, 'the unrecorded alert stays durable after delivery throws');
  assert.equal(attemptIds.length, 1, 'the first failed probe did not create a notification');

  now += 60_000;
  const delivered = await withFixtureEnvironment(box.env, () => runRelayCanary(config, { io: apiBoardOpeners, now: () => now,
    notify: async notice => { attemptIds.push(notice.id); } }));
  assert.equal(delivered.health.pendingNotifications, 0, 'returned status reflects completed notice recording');
  assert.deepEqual(attemptIds, [pending[0].id, pending[0].id], 'retry uses the same durable notice identity');
  assert.deepEqual(pendingRelayCanaryNotices(box.root), [], 'successful ordinary notice recording clears the pending delivery');

});


test('the canary command binds machine opt-in to its linked ordinary seat [H5,H17]', { timeout: 60_000 }, async t => { // budget: real linked Git fixture and bounded ordinary sealed probe, not a timing assertion.
  const box = await relayClientFixture(t);
  installPullboardEntry(box);
  await box.link();
  const refused = await box.cliLocal('relay', 'canary', 'on');
  assert.equal(refused.code, 1, 'a coordinator cannot substitute for the dedicated ordinary canary seat');
  assert.equal(refused.document.error.code, 'RELAY_CANARY_SEAT');
  const seat = await joinedCanarySeat(box);
  const enabled = await box.cliAtLocal(seat.root, 'relay', 'canary', 'on', '--timeout', '5000');
  assert.equal(enabled.code, 0, enabled.failure);
  assert.equal(enabled.document.config.agentId, seat.agentId);
  const probed = await box.cliAtLocal(seat.root, 'relay', 'canary', 'run');
  assert.equal(probed.code, 0, probed.failure);
  assert.equal(probed.document.observation.ok, true);
  assert.equal(probed.document.observation.step, 'complete');
  const off = await box.cliAtLocal(seat.root, 'relay', 'canary', 'off');
  assert.equal(off.code, 0, off.failure);
  assert.equal(off.document.config.enabled, false);
  const stopped = await box.cliAtLocal(seat.root, 'relay', 'canary', 'run');
  assert.equal(stopped.code, 1);
  assert.equal(stopped.document.error.code, 'RELAY_CANARY_CONFIG');
});


test('a stalled real board route is bounded by the probe deadline [H5,H17]', { timeout: 60_000 }, async t => { // budget: real linked fixture plus a 250 ms transport deadline, with fixture cleanup.
  const box = await relayClientFixture(t);
  installPullboardEntry(box);
  await box.link();
  const seat = await joinedCanarySeat(box);
  box.stallApi();
  const started = performance.now();
  let result;
  try { result = await withFixtureEnvironment(box.env, () => probeRelayCanary(seat.root, { io: apiBoardOpeners, agentId: seat.agentId, deadlineMs: 250 })); }
  finally { box.stallApi(false); }
  assert.equal(result.ok, false, 'an unanswered board route is never a healthy round trip');
  assert.ok(['push', 'pull'].includes(result.step), JSON.stringify(result));
  assert.ok(performance.now() - started < 5000, 'the probe drains before its normal ceiling'); // budget: the declared five-second probe ceiling bounds a stalled request.
  const healthy = await withFixtureEnvironment(box.env, () => probeRelayCanary(seat.root, { io: apiBoardOpeners, agentId: seat.agentId }));
  assert.equal(healthy.ok, true, JSON.stringify(healthy));
});
