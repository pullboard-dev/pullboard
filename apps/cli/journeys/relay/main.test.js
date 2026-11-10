/** Relay identity, expiry, permission freshness and scoped credential isolation [H8, H1]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { runRelayOnAll } from '../../tests/fixtures/relay/auth.js';
import { seedRevocation } from '../../tests/fixtures/relay/auth.js';
import { fileSnapshot } from '../../tests/fixtures/relay/auth.js';
import { livePersonSessionIds } from '../../tests/fixtures/relay/auth.js';
import { revokeFixtureSessions } from '../../tests/fixtures/relay/auth.js';
import { registerSecondProject } from '../../tests/fixtures/relay/auth.js';
import { fixture } from '../../tests/fixtures/relay/auth.js';
import { login } from '../../tests/fixtures/relay/auth.js';

test('a minted device session stays cancellable after its device grant expires [H5,N26]', async (t) => {
  const box = await fixture(t);
  const prior = await login(box);
  const grantStarted = box.now();
  box.state.deviceAuthorized = true;
  const grant = await box.auth.beginDevice();
  box.advance(grant.interval * 1000);
  const minted = await box.auth.pollDevice(grant.ticket);
  assert.equal(box.now(), grantStarted + grant.interval * 1000, 'the grant uses the injected auth clock');
  const beforeExpiry = livePersonSessionIds({ authDatabase: box.database });
  assert.equal(beforeExpiry.includes(prior.id), true, 'the preexisting session remains live');
  assert.equal(beforeExpiry.includes(minted.id), true, 'the device grant minted one new live session');

  box.advance((grant.expiresIn - grant.interval) * 1000);
  assert.equal(box.now(), grantStarted + grant.expiresIn * 1000, 'the clock reaches the exact grant deadline');
  await assert.rejects(box.auth.pollDevice(grant.ticket), { code: 'OAUTH_EXPIRED' }, 'polling remains strictly expired at the grant deadline');
  assert.deepEqual(await box.auth.cancelDevice(grant.ticket), { cancelled: true }, 'the bounded cleanup receipt revokes the session after its grant expires');
  assert.deepEqual(await box.auth.cancelDevice(grant.ticket), { cancelled: true }, 'a known cleanup remains idempotent');
  await assert.rejects(box.auth.authenticate(minted.token), { code: 'AUTH_REQUIRED' }, 'only the newly minted session is revoked');
  assert.equal((await box.auth.authenticate(prior.token)).id, prior.id, 'cleanup preserves the preexisting session');
  assert.deepEqual(livePersonSessionIds({ authDatabase: box.database }), [prior.id], 'the expired grant receipt cannot revoke another live session');
  assert.deepEqual(await box.auth.cancelDevice('pd_' + 'x'.repeat(43)), { cancelled: false }, 'an unknown ticket is never treated as cleaned up');
});

test('device-session cleanup survives grant pruning but ends at session expiry [H5,N26]', async (t) => {
  const box = await fixture(t, { sessionTTL: 30 * 60_000 });
  const prior = await login(box);
  const grantStarted = box.now();
  box.state.deviceAuthorized = true;
  const grant = await box.auth.beginDevice();
  box.advance(grant.interval * 1000);
  const minted = await box.auth.pollDevice(grant.ticket);
  box.advance((grant.expiresIn - grant.interval) * 1000);

  const nextGrant = await box.auth.beginDevice(); // pruneFlows removes the expired flow first
  assert.equal(box.now(), grantStarted + grant.expiresIn * 1000, 'the session cleanup receipt outlives only the original grant');
  await assert.rejects(box.auth.pollDevice(grant.ticket), { code: 'OAUTH_EXPIRED' }, 'pruning never makes an expired ticket pollable');
  assert.deepEqual(await box.auth.cancelDevice(grant.ticket), { cancelled: true }, 'flow pruning preserves the exact live session cleanup receipt');
  assert.deepEqual(await box.auth.cancelDevice(grant.ticket), { cancelled: true }, 'the pruned ticket receipt remains idempotent');
  await assert.rejects(box.auth.authenticate(minted.token), { code: 'AUTH_REQUIRED' }, 'the receipt revoked its own session');
  assert.equal((await box.auth.authenticate(prior.token)).id, prior.id, 'pruned-flow cleanup preserves the prior session');
  assert.deepEqual(await box.auth.cancelDevice(nextGrant.ticket), { cancelled: true }, 'the replacement grant remains independently cancellable');

  box.advance(minted.expires - box.now());
  assert.equal(box.now(), minted.expires, 'the cleanup receipt reaches the exact session expiry');
  assert.deepEqual(await box.auth.cancelDevice(grant.ticket), { cancelled: false }, 'expired cleanup receipts are no longer accepted as cancellation proof');
  await assert.rejects(box.auth.pollDevice(grant.ticket), { code: 'OAUTH_EXPIRED' }, 'an expired cleanup receipt never restores poll access');
});

test('linking every board stops cleanly when the sign-in is declined or cancelled [H5,N26]', async (t) => {
  for (const scenario of ['already-cancelled', 'declined', 'expired', 'cancelled-during-sign-in', 'cancelled-after-sign-in']) await t.test(scenario, async (t) => {
    const box = await relayClientFixture(t);
    const second = await registerSecondProject(box);
    box.refuseBoardLinks(true);
    box.providerState.deviceAuthorized = scenario !== 'cancelled-during-sign-in';
    box.providerState.deviceDeclined = scenario === 'declined';
    box.providerState.deviceExpired = scenario === 'expired';
    if (scenario === 'cancelled-after-sign-in') {
      box.overrideDelete({ status: 200 });
      assert.equal((await seedRevocation(box)).code, 0, 'a prior revocation is queued before setup begins');
    }
    const priorSession = scenario === 'cancelled-after-sign-in' ? await box.phoneSession() : null;
    const sessionsBefore = livePersonSessionIds(box);
    const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine', 'state.json');
    const before = new Map([box.linkFile, second.linkFile, box.keyFile, second.keyFile, machineFile].map(path => [path, fileSnapshot(path)]));
    if (scenario === 'cancelled-during-sign-in') {
      // A broken caller that ignores abort sees a provider denial at its first poll instead of hanging.
      setTimeout(() => { box.providerState.deviceDeclined = true; }, 100);
    }
    const mode = scenario === 'already-cancelled' ? 'already-aborted'
      : scenario === 'cancelled-during-sign-in' ? 'during-poll'
      : scenario === 'cancelled-after-sign-in' ? 'during-flush' : 'none';
    const result = await runRelayOnAll(box, mode);
    assert.equal(result.code, 0, 'the private setup caller returns a structured terminal outcome');
    const expected = scenario === 'declined' ? 'declined' : scenario === 'expired' ? 'expired' : 'cancelled';
    assert.equal(result.document.outcome, expected, 'sign-in termination has a named outcome');
    assert.deepEqual(result.document.linked ?? [], [], 'no board is linked after an interrupted sign-in');
    assert.deepEqual(result.document.failed ?? [], [], 'cancellation is not reported as a per-board failure');
    assert.deepEqual(fileSnapshot(box.linkFile), before.get(box.linkFile), 'cancelled sign-in leaves the board link file unchanged');
    assert.deepEqual(fileSnapshot(second.linkFile), before.get(second.linkFile), 'cancellation leaves the second registered board unlinked');
    assert.deepEqual(fileSnapshot(box.keyFile), before.get(box.keyFile), 'cancelled sign-in leaves the board key unchanged');
    assert.deepEqual(fileSnapshot(second.keyFile), before.get(second.keyFile), 'cancellation leaves the second board key unstored');
    assert.deepEqual(livePersonSessionIds(box), sessionsBefore, 'a pre-link terminal outcome leaves no new live person session');
    if (priorSession) assert.equal((await box.auth.authenticate(priorSession.token)).id, priorSession.id, 'cancellation preserves the preexisting person session');
    if (scenario === 'cancelled-after-sign-in') {
      const prior = JSON.parse(before.get(machineFile).toString('utf8'));
      const after = JSON.parse(fileSnapshot(machineFile).toString('utf8'));
      assert.equal(after.autoLink, prior.autoLink, 'cancellation before the first link does not enable auto-linking');
      assert.deepEqual(after.owner, prior.owner, 'cancellation before the first link does not change the saved owner');
      assert.deepEqual(after.approvals, prior.approvals, 'cancellation before the first link preserves pending approvals');
      assert.deepEqual(after.revocations, [], 'the already-queued revocation is flushed as its existing cleanup obligation');
    } else {
      assert.deepEqual(fileSnapshot(machineFile), before.get(machineFile), 'decline or cancellation during sign-in does not mutate machine metadata');
    }
    assert.equal(box.transit.some(record => /\/auth\/boards\/link$|\/auth\/machines$|^\/api\/v1\/boards\//u.test(record.path)), false,
      'no board or machine credential request begins before sign-in is committed');
    if (scenario === 'already-cancelled') {
      assert.equal(box.transit.some(record => record.path === '/auth/device/start'), false,
        'an already-aborted signal prevents the device flow from starting');
      assert.equal(box.providerCalls.some(call => call.path === '/login/oauth/access_token'), false,
        'an already-aborted signal makes no provider request');
    }
    if (scenario === 'cancelled-during-sign-in') {
      assert.equal(box.transit.some(record => record.path === '/auth/device/start'), true, 'the caller cancels an active device sign-in');
    }
    if (scenario === 'declined' || scenario === 'expired') {
      assert.equal(box.providerCalls.some(call => call.path === '/login/oauth/access_token'), true, 'the real synthetic provider returns the terminal sign-in result');
    }
  });

  await t.test('cancellation revokes a session minted behind a held poll response', async (t) => {
    const box = await relayClientFixture(t);
    const second = await registerSecondProject(box);
    box.refuseBoardLinks(true);
    const priorSession = await box.phoneSession();
    const sessionsBefore = livePersonSessionIds(box);
    const before = [box.linkFile, second.linkFile, box.keyFile, second.keyFile].map(path => [path, fileSnapshot(path)]);
    const result = await runRelayOnAll(box, 'held-poll-response');
    assert.equal(result.code, 0, 'the held response is canceled through the ticket cleanup path');
    assert.equal(result.document.outcome, 'cancelled', 'the caller reports cancellation only after cleanup confirmation');
    assert.deepEqual(livePersonSessionIds(box), sessionsBefore, 'the just-minted session is revoked');
    assert.equal((await box.auth.authenticate(priorSession.token)).id, priorSession.id, 'cleanup does not revoke a preexisting session');
    assert.equal(box.transit.filter(record => record.method === 'POST' && record.path === '/auth/device/cancel').length, 1,
      'the held device flow is canceled through its ticket');
    for (const [path, contents] of before) assert.deepEqual(fileSnapshot(path), contents, 'a canceled poll leaves board links and keys unchanged');
  });

  for (const terminal of ['denied', 'expired']) await t.test(`cancellation acknowledges a held ${terminal} poll response without changing sessions`, async (t) => {
    const box = await relayClientFixture(t);
    const second = await registerSecondProject(box);
    box.refuseBoardLinks(true);
    box.providerState.deviceDeclined = terminal === 'denied';
    box.providerState.deviceExpired = terminal === 'expired';
    const priorSession = await box.phoneSession();
    const providerCallsBeforeAttempt = box.providerCalls.length;
    const sessionsBefore = livePersonSessionIds(box);
    const before = [box.linkFile, second.linkFile, box.keyFile, second.keyFile].map(path => [path, fileSnapshot(path)]);
    const result = await runRelayOnAll(box, `held-poll-response-${terminal}`);
    assert.equal(result.code, 0, 'a known terminal provider result is cleanable while its response is held');
    assert.equal(result.document.outcome, 'cancelled', 'cancellation is confirmed for this known terminal flow');
    assert.deepEqual(livePersonSessionIds(box), sessionsBefore, 'terminal provider results mint no person session');
    assert.equal((await box.auth.authenticate(priorSession.token)).id, priorSession.id, 'terminal cleanup preserves the prior session');
    assert.equal(box.transit.filter(record => record.method === 'POST' && record.path === '/auth/device/cancel').length, 1,
      'the terminal flow is acknowledged through its exact ticket');
    assert.equal(box.providerCalls.slice(providerCallsBeforeAttempt).some(call => call.path === '/user'), false,
      'a terminal provider response never reaches identity lookup');
    assert.equal(box.transit.some(record => record.path === '/auth/boards/link' || record.path === '/auth/machines'), false,
      'terminal cancellation never begins a board or machine write');
    for (const [path, contents] of before) assert.deepEqual(fileSnapshot(path), contents, 'terminal cancellation leaves board links and keys unchanged');
  });

  await t.test('cancellation during provider polling does not mint a person session', async (t) => {
    const box = await fixture(t);
    let markStarted;
    let release;
    const started = new Promise(resolve => { markStarted = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    box.state.deviceAuthorized = true;
    box.state.beforeDevicePoll = async () => { box.state.beforeDevicePoll = null; markStarted(); await held; };
    const grant = await box.auth.beginDevice();
    box.advance(grant.interval * 1000);
    const before = livePersonSessionIds({ authDatabase: box.database });
    const poll = box.auth.pollDevice(grant.ticket);
    await started;
    const cancellation = box.auth.cancelDevice(grant.ticket);
    release();
    await assert.rejects(poll, { code: 'OAUTH_CANCELLED' }, 'the provider result is discarded after cancellation');
    assert.deepEqual(await cancellation, { cancelled: true }, 'ticket cancellation waits for the provider operation to settle');
    assert.deepEqual(livePersonSessionIds({ authDatabase: box.database }), before, 'the canceled provider result creates no session');
  });

  await t.test('cancellation during GitHub identity lookup does not mint a person session', async (t) => {
    const box = await fixture(t);
    let markStarted;
    let release;
    const started = new Promise(resolve => { markStarted = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    box.state.deviceAuthorized = true;
    box.state.beforeUser = async () => { box.state.beforeUser = null; markStarted(); await held; };
    const grant = await box.auth.beginDevice();
    box.advance(grant.interval * 1000);
    const before = livePersonSessionIds({ authDatabase: box.database });
    const poll = box.auth.pollDevice(grant.ticket);
    await started;
    const cancellation = box.auth.cancelDevice(grant.ticket);
    release();
    await assert.rejects(poll, { code: 'OAUTH_CANCELLED' }, 'the identity result is discarded after cancellation');
    assert.deepEqual(await cancellation, { cancelled: true }, 'cancellation waits for identity lookup to settle');
    assert.deepEqual(livePersonSessionIds({ authDatabase: box.database }), before, 'the canceled identity result creates no session');
  });

  await t.test('a failed cancellation acknowledgement is not reported as success', async (t) => {
    const box = await relayClientFixture(t);
    box.refuseBoardLinks(true);
    const sessionsBefore = livePersonSessionIds(box);
    const result = await runRelayOnAll(box, 'held-poll-response-cancel-fails');
    assert.notEqual(result.code, 0, 'a failed cleanup acknowledgement fails the caller closed');
    assert.equal(result.document.errorCode, 'OAUTH_CLEANUP', 'cleanup failure is surfaced as a typed refusal');
    assert.equal(box.transit.some(record => record.method === 'POST' && record.path === '/auth/device/cancel'), false,
      'the unavailable cancel endpoint receives no request at the fixture');
    const after = livePersonSessionIds(box);
    const leaked = after.filter(id => !sessionsBefore.includes(id));
    assert.equal(leaked.length, 1, 'the test confirms cleanup was not falsely reported when the endpoint was unavailable');
    assert.equal(box.transit.some(record => record.path === '/auth/boards/link' || record.path === '/auth/machines'), false,
      'failed cancellation never begins a board or machine write');
    revokeFixtureSessions(box, leaked);
  });
});

