/** A sign-in cancelled while its poll response is held leaves no session, link or key behind [H5,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { runRelayOnAll } from '../../tests/fixtures/relay/auth.js';
import { fileSnapshot } from '../../tests/fixtures/relay/auth.js';
import { livePersonSessionIds } from '../../tests/fixtures/relay/auth.js';
import { revokeFixtureSessions } from '../../tests/fixtures/relay/auth.js';
import { registerSecondProject } from '../../tests/fixtures/relay/auth.js';
import { fixture } from '../../tests/fixtures/relay/auth.js';

test('a cancelled sign-in with a held poll response leaves no person session, link or key behind [H5,N26]', async (t) => {
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

