/** Exercise ordinary canary notification delivery through a real linked fixture, not a callback stand-in [H5,H17]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  join,
} from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import { runFixtureGit } from '../../../tests/fixtures/child.js';

/** Install the isolated Pullboard entry point; the fixture already committed its configuration through the hook. */
function installPullboardEntry(box) {
  const cli = fileURLToPath(new URL('../../../pullboard.js', import.meta.url));
  const privateBin = box.env.PATH.split(delimiter)[0];
  const pullboard = join(privateBin, 'pullboard');
  assert.equal(existsSync(pullboard), false, 'never overwrite an existing fixture executable');
  writeFileSync(pullboard, `#!/bin/sh\nexec node "${cli}" "$@"\n`, { mode: 0o700 });
}

/** Use a genuine joined worktree, with no coordinator identity or environment credential substitution. */
async function joinedCanarySeat(box) {
  const root = join(box.root, '..', 'notice-canary-seat');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'agent/notice-canary', root], { cwd: box.root, env: box.env });
  const joined = await box.cliAt(root, 'join', box.lane, '--model', 'notice-canary-fixture');
  assert.equal(joined.code, 0, joined.failure);
  assert.equal(typeof joined.document.agent, 'string');
  assert.notEqual(joined.document.agent, 'coordinator');
  return { root, agentId: joined.document.agent };
}

/** Read private machine telemetry only through the normal status command. */
async function status(box, seat) {
  const result = await box.cliAt(seat.root, 'relay', 'canary', 'status');
  assert.equal(result.code, 0, result.failure);
  assert.equal(result.document.config.agentId, seat.agentId);
  return result.document.health;
}

test('the ordinary canary command retains outage notices then records delayed alert and recovery for both native readers [H5,H17]', { timeout: 60_000 }, async t => { // budget: private linked Git fixture, four bounded probes, normal message delivery and cleanup; no timing oracle.
  const box = await relayClientFixture(t);
  installPullboardEntry(box);
  await box.link();
  const seat = await joinedCanarySeat(box);
  const enabled = await box.cliAt(seat.root, 'relay', 'canary', 'on', '--timeout', '5000');
  assert.equal(enabled.code, 0, enabled.failure);
  assert.equal(enabled.document.config.agentId, seat.agentId);
  const baseline = await box.cliAt(seat.root, 'relay', 'canary', 'run');
  assert.equal(baseline.code, 0, baseline.failure);
  assert.equal(baseline.document.observation.ok, true);

  const origin = box.origin;
  await box.stopRelay();
  const first = await box.cliAt(seat.root, 'relay', 'canary', 'run');
  assert.equal(first.code, 1, 'a stopped relay cannot complete a sealed round trip');
  const once = await status(box, seat);
  assert.equal(once.consecutiveFailures, 1, 'the normal CLI recorded its own failed round trip');
  assert.equal(once.pendingNotifications, 0, 'one failure has not yet raised the two-failure alert');
  const second = await box.cliAt(seat.root, 'relay', 'canary', 'run');
  assert.equal(second.code, 1, 'an outage cannot claim successful notification delivery');
  const pending = await status(box, seat);
  assert.equal(pending.consecutiveFailures, 2);
  assert.equal(pending.status, 'degraded');
  assert.equal(pending.pendingNotifications, 1, 'the unrecorded alert remains durable across independent CLI processes');
  assert.equal(typeof pending.alertSince, 'string');

  await box.restartRelay();
  assert.equal(box.origin, origin, 'the fixture restarts the same listener and journal, not a replacement linked origin');
  const recovered = await box.cliAt(seat.root, 'relay', 'canary', 'run');
  assert.equal(recovered.code, 0, recovered.failure);
  assert.equal(recovered.document.observation.ok, true);
  assert.equal(recovered.document.health.pendingNotifications, 0, 'only actual recording to every native reader clears the queue');
  const final = await status(box, seat);
  assert.equal(final.status, 'healthy');
  assert.equal(final.pendingNotifications, 0);

  const exported = await box.cli('export');
  assert.equal(exported.code, 0, exported.failure);
  assert.ok(Array.isArray(exported.document.tables.shout), 'export exposes native shout rows with actual sender and recipient');
  const notices = exported.document.tables.shout.filter(row => row.shout_from === seat.agentId && /Relay canary (?:alert|recovery) at/u.test(row.shout_text));
  assert.equal(notices.length, 4, 'one alert and one recovery are actually recorded for each of the two native recipients');
  for (const to of ['coordinator', 'person']) {
    const alerts = notices.filter(row => row.shout_to === to && /Relay canary alert at/u.test(row.shout_text));
    const recoveries = notices.filter(row => row.shout_to === to && /Relay canary recovery at/u.test(row.shout_text));
    assert.equal(alerts.length, 1, `one actual alert reaches native ${to}`);
    assert.match(alerts[0].shout_text, /^DELAYED:/u, 'a queued outage alert remains labelled delayed even when the current probe recovered');
    assert.match(alerts[0].shout_text, /not a phone acknowledgement/u, 'native receipt is not phone delivery evidence');
    assert.equal(recoveries.length, 1, `one actual recovery reaches native ${to}`);
  }
  const off = await box.cliAt(seat.root, 'relay', 'canary', 'off');
  assert.equal(off.code, 0, off.failure);
});
