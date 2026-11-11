/** Ordinary client traffic cannot change the configured monitor's alert window [H5,H17]. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { observeRelayHealth } from '../../../../../packages/link/index.js';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';

const SLOW = { ok: true, step: 'complete', code: 'OK', roundTripMs: 2101, relayVersion: 1 };
const FAST = { ...SLOW, roundTripMs: 10 };
const FAILED = { ok: false, step: 'pull', code: 'RELAY_UNAVAILABLE', roundTripMs: 100, relayVersion: 1 };

test('ordinary traffic does not start or populate the canary ten-minute latency window [H5,H17]', async t => {
  const box = await relayClientFixture(t);
  const start = Date.parse('2026-01-01T00:00:00Z');
  observeRelayHealth(box.root, SLOW, { now: start, alerts: false });
  for (let i = 1; i <= 20; i += 1) observeRelayHealth(box.root, SLOW, { now: start + i * 30000, alerts: false });
  const firstProbe = observeRelayHealth(box.root, SLOW, { now: start + 600000 });
  assert.equal(firstProbe.transition, null, 'one monitor probe cannot inherit ten minutes of ordinary client requests');
  assert.equal(firstProbe.health.p95Ms, null);
  let last;
  for (let i = 1; i <= 10; i += 1) {
    const now = start + 600000 + i * 60000;
    for (let j = 0; j < 150; j += 1) observeRelayHealth(box.root, FAST, { now, alerts: false });
    last = observeRelayHealth(box.root, SLOW, { now });
  }
  assert.equal(last.transition, 'alert', 'ordinary request volume cannot flush slow monitor samples');
  assert.equal(last.health.p95Ms, 2101);
});

test('ordinary success cannot clear the active canary episode before a successful probe [H5,H17]', async t => {
  const box = await relayClientFixture(t);
  const start = Date.parse('2026-01-01T00:00:00Z');
  observeRelayHealth(box.root, FAILED, { now: start });
  const alert = observeRelayHealth(box.root, FAILED, { now: start + 60000 });
  assert.equal(alert.transition, 'alert');
  const ordinary = observeRelayHealth(box.root, FAST, { now: start + 61000, alerts: false });
  assert.equal(ordinary.transition, null);
  assert.equal(ordinary.health.status, 'degraded');
  assert.equal(ordinary.health.since, alert.health.since);
  assert.equal(ordinary.health.consecutiveFailures, 2);
  const recovered = observeRelayHealth(box.root, FAST, { now: start + 120000 });
  assert.equal(recovered.transition, 'recovery');
  assert.equal(recovered.health.status, 'healthy');
});
