/** A relay read survives one reset connection, resets never repeat writes, and read recovery stays bounded [H3,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayResetSample } from '../../fixtures/relay/reset.js';
import { request as relayRequest } from '../../../index.js';

/** A real worker closes the pooled socket while the client cannot process that closure. */
test('link.reset.read-survives-one-reset: a relay read survives one reset connection [H3,H16]', { timeout: 60_000 }, async () => { // budget: hang ceiling for real TCP fault and closure-control fixtures.
  const reset = await relayResetSample();
  assert.equal(reset.success, true, 'the read recovers from the real abrupt peer reset');
  assert.equal(reset.server.resets, 1, 'the fault was physically injected');
  assert.equal(reset.socketBeforeRead.destroyed, false, 'the client had not yet consumed the peer closure');
  assert.equal(reset.server.requests, 2, 'the server receives the warmup and one successful read');
  assert.equal(reset.server.mutations, 0);
  assert.ok(reset.readAttempts <= 2, 'the application makes at most one replacement read');
  assert.equal(reset.sameReadSignal, true, 'a replacement keeps the original deadline signal');
  for (const mode of ['processed', 'fresh']) {
    const control = await relayResetSample(mode);
    assert.equal(control.success, true, mode + ': removing the stale-connection condition succeeds');
    assert.equal(control.readAttempts, 1, mode + ': a healthy read is not repeated');
  }
});

test('link.reset.writes-never-repeat: relay resets never blindly repeat writes [H3,H16]', { timeout: 60_000 }, async () => { // budget: hang ceiling for four independently owned real TCP write fixtures.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const write = await relayResetSample('write-reset', { method });
    assert.equal(write.success, false, method + ': a lost write reply remains ambiguous');
    assert.equal(write.code, 'RELAY_UNAVAILABLE');
    assert.equal(write.readAttempts, 1, method + ': no second transport call');
    assert.equal(write.server.mutations, 1, method + ': the applied effect happens once');
  }
});

test('link.reset.recovery-bounded: relay read recovery stays bounded and preserves refusals, invalid bodies and cancellation [H3,H16]', { timeout: 60_000 }, async () => { // budget: hang ceiling for bounded fault, refusal and cancellation fixtures.
  const reset = await relayResetSample('always-reset');
  assert.equal(reset.success, false);
  assert.equal(reset.code, 'RELAY_UNAVAILABLE');
  assert.equal(reset.readAttempts, 2, 'a second broken transport ends the read');
  const refused = await relayResetSample('http-refusal');
  assert.equal(refused.code, 'FIXTURE_REFUSAL');
  assert.equal(refused.readAttempts, 1, 'HTTP refusals are not transport retries');
  const invalid = await relayResetSample('body-invalid');
  assert.equal(invalid.code, 'RELAY_RESPONSE');
  assert.equal(invalid.readAttempts, 1, 'invalid bodies are not transport retries');
  const cancelled = await relayResetSample('abort-reset');
  assert.equal(cancelled.code, 'OAUTH_CANCELLED');
  assert.equal(cancelled.readAttempts, 1, 'cancellation wins at the reset boundary');
  await assert.rejects(relayRequest({ url: 'http://127.0.0.1:1' }, '/fixture', { signal: {} }, { ignoreRelayEnvironmentToken: true }),
    error => error.code === 'RELAY_UNAVAILABLE', 'invalid signal setup keeps its existing transport refusal');
});
