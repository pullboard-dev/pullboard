/** Relay identity, expiry, permission freshness and scoped credential isolation [H8, H1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { runRelayOnAll } from '../../tests/fixtures/relay/auth.js';
import { registerSecondProject } from '../../tests/fixtures/relay/auth.js';
import { fixture } from '../../tests/fixtures/relay/auth.js';
import { login } from '../../tests/fixtures/relay/auth.js';

test('cli.journeys-relay-main-pairing.a-cancel-during-pairing-keeps-the: a cancel during pairing keeps the links and stops pairing cleanly [H5,N26]', async (t) => {
  await t.test('cancellation before the first link remains a no-link outcome', async (t) => {
    const box = await relayClientFixture(t);
    await registerSecondProject(box);
    const result = await runRelayOnAll(box, 'already-aborted');
    assert.equal(result.code, 0);
    assert.equal(result.document.outcome, 'cancelled');
    assert.deepEqual(result.document.linked ?? [], []);
    assert.equal(box.transit.some(record => record.path === '/auth/boards/link'), false, 'no board-link request starts');
    assert.equal(result.document.pairingCallbackCount, 0, 'no pairing URL is announced');
  });

  for (const mode of ['pairing-cancel', 'pairing-cancel-delete-fails']) await t.test(mode, async (t) => {
    const box = await relayClientFixture(t);
    await registerSecondProject(box);
    const result = await runRelayOnAll(box, mode);
    assert.equal(result.code, 0, 'pairing cancellation is a named successful setup outcome');
    assert.equal(result.document.pairingOutcome, 'cancelled');
    assert.equal(result.document.paired, false);
    assert.equal(result.document.linked.length, 2, 'the completed board links remain in the result');
    assert.deepEqual(result.document.failed, []);
    assert.equal(result.document.pendingCleared, true, 'the local pending enrollment is removed');
    assert.equal(result.document.deviceCount, 0, 'cancellation before acceptance records no device');
    assert.equal(result.document.pairingCallbackCount, 1, 'the optional pairing callback receives the pairing address');
    assert.equal(result.document.pairingCallbackHasCode, true);
    assert.equal(result.document.pairingCallbackExpires, true);
    assert.equal(result.document.pairingUrlPrinted, false, 'the callback replaces CLI URL/QR output');
    assert.equal(result.document.signalAborted, true);
    if (mode === 'pairing-cancel') {
      assert.equal(result.document.pairingCleanup, 'confirmed');
      assert.equal(box.transit.filter(record => record.method === 'DELETE' && /\/api\/v1\/devices\/enrollments\//u.test(record.path)).length, 1);
    } else {
      assert.equal(result.document.pairingCleanup, 'unconfirmed', 'a refused DELETE is not reported as cleanup success');
      assert.equal(result.document.pairingCleanupWarningShown, true);
    }
  });

  for (const mode of ['pairing-complete', 'pairing-abort-during-acceptance']) await t.test(mode, async (t) => {
    const box = await relayClientFixture(t);
    await registerSecondProject(box);
    const result = await runRelayOnAll(box, mode);
    assert.equal(result.code, 0, 'the real loopback enrollment completes');
    assert.equal(result.document.pairingCallbackCount, 1, 'the optional pairing callback receives the pairing address');
    assert.equal(result.document.pairingUrlPrinted, false, 'the callback replaces CLI URL/QR output');
    assert.equal(result.document.pairingOutcome, 'paired');
    assert.equal(result.document.paired, true);
    assert.equal(result.document.linked.length, 2);
    assert.deepEqual(result.document.failed, []);
    assert.equal(result.document.pairingCallbackHasCode, true);
    assert.equal(result.document.enrollmentUploaded, true);
    assert.equal(result.document.pendingCleared, true);
    assert.equal(result.document.deviceCount, 1);
    assert.equal(box.transit.filter(record => record.method === 'PUT' && /\/api\/v1\/devices\/device-[0-9a-f]{32}\/boards\//u.test(record.path)).length, 2,
      'the enrolled device receives wraps for every linked board');
    assert.equal(result.document.signalAborted, mode === 'pairing-abort-during-acceptance');
  });
});

test('cli.journeys-relay-main-pairing.browser-state-cookie-binding-and-one: browser state/cookie binding and one-use device ticket protect both sign-in flows [H8, H1]', async (t) => {
  const box = await fixture(t);
  const web = box.auth.beginWeb();
  const authorized = await fetch(web.authorizationURL, { redirect: 'manual' });
  const callback = new URL(authorized.headers.get('location'));
  const state = callback.searchParams.get('state');
  const code = callback.searchParams.get('code');
  await assert.rejects(box.auth.finishWeb(state, code, 'wrong-browser'), { code: 'OAUTH_STATE' });
  const signed = await box.auth.finishWeb(state, code, web.binding);
  assert.equal((await box.auth.authenticate(signed.token)).user.id, '7');
  await assert.rejects(box.auth.finishWeb(state, code, web.binding), { code: 'OAUTH_STATE' });
  const grant = await box.auth.beginDevice();
  assert.equal(grant.deviceCode, undefined);
  const polls = box.calls.filter(call => call.path === '/login/oauth/access_token').length;
  assert.equal((await box.auth.pollDevice(grant.ticket)).pending, true);
  assert.equal(box.calls.filter(call => call.path === '/login/oauth/access_token').length, polls);
  box.advance(1000);
  box.state.slow = true;
  assert.equal((await box.auth.pollDevice(grant.ticket)).retryAfter, 6);
  box.advance(6000);
  box.state.deviceAuthorized = true;
  const cli = await box.auth.pollDevice(grant.ticket);
  assert.equal((await box.auth.authenticate(cli.token)).user.id, '7');
  await assert.rejects(box.auth.pollDevice(grant.ticket), { code: 'OAUTH_EXPIRED' });
});
