/** Relay identity, expiry, permission freshness and scoped credential isolation [H8, H1]. */
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { openRelayConfirmation } from '../../tests/fixtures/relay/auth.js';
import { linkedBoardCount } from '../../tests/fixtures/relay/auth.js';
import { runRelayOnAll } from '../../tests/fixtures/relay/auth.js';
import { registerSecondProject } from '../../tests/fixtures/relay/auth.js';
import { fixture } from '../../tests/fixtures/relay/auth.js';
import { login } from '../../tests/fixtures/relay/auth.js';

test('a cancel during pairing keeps the links and stops pairing cleanly [H5,N26]', async (t) => {
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

test('browser state/cookie binding and one-use device ticket protect both sign-in flows [H8, H1]', async (t) => {
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

test('relay on from an SSH shell links only after the person confirms in the browser [P6, H5, H8, B26]', async (t) => {
  const box = await relayClientFixture(t);
  const ssh = { SSH_CONNECTION: '192.0.2.10 12345 192.0.2.20 22', PULLBOARD_RELAY_TOKEN: 'pa_' + 'x'.repeat(43) };
  const running = box.startCli(['relay', 'on', '--url', box.origin], ssh);
  const marker = 'After sign-in, confirm the link in your browser: ';
  const output = await running.waitForOutput(marker);
  const startResponse = await box.waitForResponse('/auth/device/start');
  const deviceGrant = JSON.parse(startResponse.response.toString());
  const line = output.split('\n').find(value => value.includes(marker));
  const confirmationURL = line?.slice(line.indexOf(marker) + marker.length).trim();
  assert.ok(confirmationURL, 'SSH sign-in prints the separate browser confirmation address');
  await box.waitForResponse('/auth/device/poll');
  const browser = await openRelayConfirmation(box, confirmationURL);
  assert.ok(browser.cookieMaxAge > 600 && browser.cookieMaxAge <= deviceGrant.expiresIn + 600,
    'an early browser visit remains bound through the remaining device grant and ten-minute confirmation window');
  const status = await browser.status();
  assert.equal(status.response.status, 200);
  assert.equal(status.document.ready, true, 'the relay holds the GitHub session until the device grant is complete');
  assert.equal(status.document.intent.boardName, basename(box.root));
  assert.equal(status.document.intent.host, hostname());
  assert.equal(JSON.stringify(status.document).includes('token'), false, 'the browser status does not expose a relay credential');
  assert.equal(linkedBoardCount(box.authDatabase), 0, 'no board is linked before the person confirms');
  const foreignDecision = await browser.decide('confirm', 'https://foreign.invalid');
  assert.equal(foreignDecision.status, 403, 'a foreign origin cannot confirm even with the browser cookie');
  assert.equal(linkedBoardCount(box.authDatabase), 0, 'a refused cross-origin decision creates no link');
  const confirmed = await browser.decide('confirm');
  assert.equal(confirmed.status, 200, 'the exact-origin browser action confirms the displayed intent');
  assert.equal(linkedBoardCount(box.authDatabase), 1, 'the relay links only after affirmative confirmation');
  const completed = await running.closed;
  assert.equal(completed.signal, null);
  assert.equal(completed.code, 0, 'SSH relay on receives the person session only after confirmation');
  assert.equal(JSON.parse(completed.stdout).linked, true);

  const declineBox = await relayClientFixture(t);
  const declinedRun = declineBox.startCli(['relay', 'on', '--url', declineBox.origin], { SSH_TTY: '/dev/pts/8' });
  const declinedOutput = await declinedRun.waitForOutput(marker);
  const declinedLine = declinedOutput.split('\n').find(value => value.includes(marker));
  const declinedURL = declinedLine?.slice(declinedLine.indexOf(marker) + marker.length).trim();
  assert.ok(declinedURL);
  await declineBox.waitForResponse('/auth/device/poll');
  const declinedBrowser = await openRelayConfirmation(declineBox, declinedURL);
  assert.equal((await declinedBrowser.status()).document.ready, true);
  assert.equal((await declinedBrowser.decide('decline')).status, 200);
  const declined = await declinedRun.closed;
  assert.equal(declined.code, 1, 'the CLI reports a person decline');
  assert.equal(JSON.parse(declined.stdout).error.code, 'OAUTH_DENIED');
  assert.equal(linkedBoardCount(declineBox.authDatabase), 0, 'declining leaves the board unlinked');

  const startsBeforeRefusals = box.calls.filter(call => call.path === '/auth/device/start').length;
  const agent = await runCliInProcess(['relay', 'on', '--url', box.origin, '--json'], {
    cwd: box.root, env: { ...box.env, SSH_CONNECTION: ssh.SSH_CONNECTION, AI_AGENT: '1' },
  });
  assert.equal(agent.status, 1);
  assert.equal(JSON.parse(agent.stdout).error.code, 'B26_PERSON_CHANNEL', 'an agent-marked SSH shell still cannot link');
  const personAnswer = await runCliInProcess(['answer', '1', 'yes', '--as', 'person', '--json'], {
    cwd: box.root, env: { ...box.env, SSH_CONNECTION: ssh.SSH_CONNECTION },
  });
  assert.equal(personAnswer.status, 1);
  assert.equal(JSON.parse(personAnswer.stdout).error.code, 'B26_PERSON_CHANNEL', 'other person-only SSH actions remain refused');
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, startsBeforeRefusals,
    'refused shell actions never start another browser grant');
});

test('an unanswered device board confirmation expires after ten minutes [H8]', async (t) => {
  const box = await fixture(t);
  const intent = { board: 'ssh-board', boardName: 'fixture-board', host: 'fixture-host', repository: 'fixture/repository' };
  const flow = await box.auth.beginDevice({ intent });
  box.state.deviceAuthorized = true;
  box.advance(flow.interval * 1000);
  const pending = await box.auth.pollDevice(flow.ticket);
  assert.equal(pending.pendingConfirmation, true);
  assert.equal('token' in pending, false, 'the CLI ticket does not return the held person session');
  const browser = box.auth.openDeviceConfirmation(flow.confirmationTicket);
  const status = box.auth.deviceConfirmationStatus(flow.confirmationTicket, browser.binding);
  assert.equal(status.ready, true);
  assert.equal('token' in status, false, 'browser status contains no relay credential');
  box.advance(10 * 60_000);
  await assert.rejects(box.auth.pollDevice(flow.ticket), { code: 'OAUTH_EXPIRED' });
  assert.equal(linkedBoardCount(box.database), 0, 'an unanswered intent never links a board');
  const db = new DatabaseSync(box.database);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM relay_credentials WHERE kind='session' AND revoked=1").get().count, 1,
      'the server-held session is revoked after the confirmation deadline');
  } finally { db.close(); }
});

test('a confirmation approved before its deadline can reach the SSH CLI just after ten minutes [P6, H5]', async (t) => {
  const box = await fixture(t);
  const intent = { board: 'ssh-board', boardName: 'fixture-board', host: 'fixture-host', repository: 'fixture/repository' };
  const flow = await box.auth.beginDevice({ intent });
  const browser = box.auth.openDeviceConfirmation(flow.confirmationTicket);
  box.state.deviceAuthorized = true;
  box.advance(flow.interval * 1000);
  const pending = await box.auth.pollDevice(flow.ticket);
  assert.equal(pending.pendingConfirmation, true);
  box.advance(599_000);
  const approved = await box.auth.confirmDevice(flow.confirmationTicket, browser.binding, 'confirm');
  assert.equal(approved.confirmed, true, 'the person approved before the original confirmation deadline');
  box.advance(2_000);
  const delivered = await box.auth.pollDevice(flow.ticket);
  assert.equal(delivered.linkConfirmed, true, 'the valid approval remains retrievable after its decision deadline');
  assert.equal(delivered.linkedBoard, intent.board);
  // Not CLI wording: the credential format is the in-process box.auth.pollDevice() API contract, so a pattern is the right assert.
  assert.match(delivered.token, /^ps_[A-Za-z0-9_-]{43}$/u);
});

test('device authorization stays serialized while GitHub confirms its user [P6, H5]', async (t) => {
  const box = await fixture(t);
  const intent = { board: 'ssh-board', boardName: 'fixture-board', host: 'fixture-host', repository: 'fixture/repository' };
  const flow = await box.auth.beginDevice({ intent });
  const originalUser = box.config.github.user;
  let releaseLookup;
  let announceLookup;
  const lookupStarted = new Promise((resolve) => { announceLookup = resolve; });
  const lookupHeld = new Promise((resolve) => { releaseLookup = resolve; });
  let lookupCount = 0;
  box.config.github.user = async (token) => {
    lookupCount += 1;
    if (lookupCount === 1) {
      announceLookup();
      await lookupHeld;
    }
    return originalUser(token);
  };
  box.state.deviceAuthorized = true;
  box.advance(flow.interval * 1000);
  let firstPoll;
  try {
    firstPoll = box.auth.pollDevice(flow.ticket);
    await lookupStarted;
    const providerPolls = () => box.calls.filter((call) => call.path === '/login/oauth/access_token').length;
    assert.equal(providerPolls(), 1, 'the first provider poll produced the grant now being resolved');
    box.advance(flow.interval * 1000);
    const concurrent = await box.auth.pollDevice(flow.ticket);
    assert.equal(concurrent.pending, true, 'a second CLI request waits while identity confirmation finishes');
    assert.equal(concurrent.pendingConfirmation, undefined, 'the held session is not exposed as ready yet');
    assert.equal(providerPolls(), 1, 'the concurrent CLI request cannot consume the provider grant again');

    releaseLookup();
    const pending = await firstPoll;
    assert.equal(pending.pendingConfirmation, true);
    assert.equal('token' in pending, false, 'the held session remains unavailable before person approval');
    const browser = box.auth.openDeviceConfirmation(flow.confirmationTicket);
    const status = box.auth.deviceConfirmationStatus(flow.confirmationTicket, browser.binding);
    assert.equal(status.ready, true, 'the original browser confirmation remains attached to the authorized device flow');
    assert.equal('token' in status, false, 'browser status never returns the held session credential');
    const waiting = await box.auth.pollDevice(flow.ticket);
    assert.equal(waiting.pendingConfirmation, true, 'the CLI keeps waiting for the person decision');
    assert.equal('token' in waiting, false);
    assert.equal(lookupCount, 1, 'one successful device grant creates one server-held user session');
  } finally {
    releaseLookup();
    if (firstPoll) await firstPoll.catch(() => {});
  }
});

test('unreadable links are refused; agent tokens belong to exactly one board [H8, H1]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  box.state.access = false;
  await assert.rejects(box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository'), { code: 'NO_REPO_ACCESS' });
  assert.deepEqual(await box.auth.boardsFor(signed.token), []);
  box.state.access = true;
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  await box.auth.linkBoard(signed.token, 'beta', 'fixture/repository-2'); // one team board per repository [E12]
  const agent = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker-1' });
  assert.equal((await box.auth.authenticate(agent.token, { board: 'alpha', write: true })).agent, 'worker-1');
  const before = box.calls.length;
  await assert.rejects(box.auth.authenticate(agent.token, { board: 'beta', write: true }), { code: 'TOKEN_BOARD' });
  assert.equal(box.calls.length, before, 'cross-board credentials are rejected before a provider check');
  assert.deepEqual((await box.auth.boardsFor(agent.token)).map(board => board.id), ['alpha']);
  await assert.rejects(box.auth.linkBoard(agent.token, 'gamma', 'fixture/repository'), { code: 'HUMAN_REQUIRED' });
});
