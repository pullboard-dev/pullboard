// pullboard: browser
/** @pullboard-test-gui */
/** A real browser confirms the exact SSH relay board intent [P6,H5]. */
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { relayClientFixture } from '../../../test/relay-client-fixture.js';
import { findChromeExecutable } from '../../../test/relay-browser-fixture.js';
import { startChrome } from '../../../test/relay-browser-fixture.js';
import { enrollProtocolPhone } from '../../../test/relay-device-enrollment-fixture.js';

const CONFIRMATION_PROMPT = 'After sign-in, confirm the link in your browser: ';
const CONFIRMATION_POLL_INTERVAL_MS = 2000;

/** Count real browser status requests without retaining their tickets or request bodies. */
function confirmationStatusRequestCount(box) {
  return box.calls.filter(call => call.method === 'POST' && call.path === '/auth/device/confirmation/status').length;
}

/** Count linked boards through a read-only connection to the private relay database. */
function linkedBoardCount(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS count FROM relay_boards').get().count; }
  finally { db.close(); }
}

/** Click a visible production confirmation button through real Chrome mouse input. */
async function clickConfirmationButton(chrome, selector, label) {
  const point = await chrome.evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, `move to ${label}`);
  await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, `press ${label}`);
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, `release ${label}`);
}

/** Exercise a real terminal decision while a pre-decision status request remains in flight. */
async function keepTerminalConfirmation(t, decision) {
  const box = await relayClientFixture(t);
  const heldStatus = box.holdNextConfirmationStatus();
  const chrome = await startChrome();
  let running;
  try {
    running = box.startCli(['relay', 'on', '--url', box.origin], {
      SSH_CONNECTION: '192.0.2.10 12345 192.0.2.20 22',
    });
    const output = await running.waitForOutput(CONFIRMATION_PROMPT);
    const line = output.split('\n').find((value) => value.includes(CONFIRMATION_PROMPT));
    const confirmationURL = line?.slice(line.indexOf(CONFIRMATION_PROMPT) + CONFIRMATION_PROMPT.length).trim();
    assert.ok(confirmationURL, 'SSH relay on prints the person confirmation address');
    assert.equal(new URL(confirmationURL).origin, box.origin, 'confirmation stays on the configured relay origin');
    await box.waitForResponse('/auth/device/poll');

    await chrome.navigate(confirmationURL);
    await heldStatus.started;
    await chrome.waitFor('document.querySelector("#confirm")?.hidden === false && document.querySelector("#decline")?.hidden === false',
      undefined, 'the real page enables the decision after GitHub sign-in');
    assert.equal(await chrome.evaluate('location.hash === ""'), true, 'the page removes the one-use nonce from browser history');
    assert.equal(await chrome.evaluate('document.querySelector("#intent").textContent'),
      `Link ${basename(box.root)} from ${hostname()}?`, 'the real page displays the bound board and machine');
    assert.equal(linkedBoardCount(box.authDatabase), 0, 'opening the browser confirmation does not link a board');

    await clickConfirmationButton(chrome, decision === 'confirm' ? '#confirm' : '#decline', `${decision} button`);
    const terminalText = decision === 'confirm'
      ? 'The board is linked. You can return to the terminal.'
      : 'You declined this board link. Nothing was linked.';
    await chrome.waitFor(`document.querySelector("#status")?.textContent === ${JSON.stringify(terminalText)}`,
      undefined, 'the real page reports the completed terminal decision');
    const completed = await running.closed;
    assert.equal(completed.signal, null);
    if (decision === 'confirm') {
      assert.equal(completed.code, 0, 'the SSH CLI receives the confirmed session');
      assert.equal(JSON.parse(completed.stdout).linked, true);
      assert.equal(linkedBoardCount(box.authDatabase), 1, 'the browser click links the displayed board');
    } else {
      assert.notEqual(completed.code, 0, 'the SSH CLI receives the declined-flow refusal');
      assert.equal(linkedBoardCount(box.authDatabase), 0, 'declining leaves the board unlinked');
    }

    heldStatus.release();
    const lateStatus = await heldStatus.finished;
    const lateResponse = JSON.parse(lateStatus.response.toString('utf8'));
    assert.equal(lateResponse.error?.code, 'OAUTH_EXPIRED', 'the in-flight request reaches the real handler after CLI flow consumption');
    const statusRequestsAfterLateResponse = confirmationStatusRequestCount(box);
    await chrome.evaluate(`new Promise(resolve => setTimeout(resolve, ${CONFIRMATION_POLL_INTERVAL_MS * 2}))`,
      'wait through one full confirmation polling cadence after CLI flow consumption');
    assert.equal(await chrome.evaluate('document.querySelector("#status").textContent'), terminalText,
      'a late expired-flow status response and later polling cadence preserve the terminal message');
    assert.equal(await chrome.evaluate('document.querySelector("#confirm").hidden && document.querySelector("#decline").hidden'), true,
      'terminal decisions leave both buttons hidden');
    assert.equal(confirmationStatusRequestCount(box), statusRequestsAfterLateResponse,
      'the terminal page sends no more status requests after the next polling cadence');
    for (const path of ['/auth/device/confirmation/open', '/auth/device/confirmation/status', '/auth/device/confirmation']) {
      assert.ok(box.calls.some((call) => call.path === path), `the real browser called ${path}`);
    }
  } finally {
    heldStatus.release();
    if (running && running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill('SIGKILL');
      await running.closed;
    }
    await chrome.close();
  }
}

/** Confirm from the real page and keep it alive after the CLI consumes its flow. */
async function confirmTerminalIntent(t) {
  await keepTerminalConfirmation(t, 'confirm');
}

/** Decline from the real page and keep it alive after the CLI consumes its flow. */
async function declineTerminalIntent(t) {
  await keepTerminalConfirmation(t, 'decline');
}

test('real Chrome confirms the displayed SSH board intent [P6,H5]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, confirmTerminalIntent);

test('real Chrome keeps a declined SSH board intent terminal after CLI consumption [P6,H5]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, declineTerminalIntent);

/** Wait only for the private command's first management choice, with a finite hang ceiling. */
async function waitForManagementChoice(box, offset) {
  const deadline = Date.now() + 20_000; // budget: private request-handshake hang ceiling, not a throughput assertion.
  while (Date.now() < deadline) {
    if (box.calls.slice(offset).some(call => call.path === '/auth/device/start' ||
        call.method === 'POST' && call.path === '/api/v1/devices/approvals')) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('the private command never requested a sign-in or a phone approval');
}

/** Inspect only counts and public device state, never credential hashes or bearer values. */
function activeSessionCount(box) {
  const db = new DatabaseSync(box.authDatabase, { readOnly: true });
  try { return db.prepare("SELECT COUNT(*) AS count FROM relay_credentials WHERE kind='session' AND revoked=0").get().count; }
  finally { db.close(); }
}

/** Read the real relay's public revocation flag for one synthetic fixture device. */
function deviceRevoked(box, deviceId) {
  const db = new DatabaseSync(join(box.relayDirectory, 'devices.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT revoked FROM device WHERE id=?').get(deviceId)?.revoked; }
  finally { db.close(); }
}

test('revoking the only approving phone asks for a fresh sign-in instead [H17,E16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const deviceId = await enrollProtocolPhone(box);
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  assert.deepEqual(JSON.parse(readFileSync(machineFile, 'utf8')).devices.map(device => device.deviceId), [deviceId]);
  assert.equal(deviceRevoked(box, deviceId), 0, 'the private phone is active before revocation');
  const sessionsBefore = activeSessionCount(box);
  const offset = box.calls.length;
  box.providerState.deviceAuthorized = false;
  const running = box.startCli(['relay', 'revoke', deviceId]);
  await waitForManagementChoice(box, offset);
  assert.ok(box.calls.slice(offset).some(call => call.path === '/auth/device/start'),
    'the lost phone cannot be the approver: start a fresh GitHub device-code sign-in');
  await running.waitForOutput('Sign in with GitHub: open ');
  assert.equal(deviceRevoked(box, deviceId), 0, 'no revocation happens before the fresh sign-in succeeds');
  assert.equal(box.calls.slice(offset).some(call => call.path === '/api/v1/devices/approvals'), false,
    'no approval is sent to the unavailable target phone');
  box.providerState.deviceAuthorized = true;
  const result = await running.closed;
  assert.equal(result.code, 0, 'the person can revoke the only phone after fresh sign-in');
  assert.equal(JSON.parse(result.stdout).revoked, true);
  assert.equal(deviceRevoked(box, deviceId), 1, 'the real relay tombstones the device');
  assert.deepEqual(JSON.parse(readFileSync(machineFile, 'utf8')).devices, [], 'native wrapping no longer trusts the phone');
  assert.equal(activeSessionCount(box), sessionsBefore, 'the fresh revocation session is revoked instead of retained');
});

test('an agent cannot revoke a device without the person [H17,E16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const deviceId = await enrollProtocolPhone(box);
  const offset = box.calls.length;
  const running = box.startCli(['relay', 'revoke', deviceId], { CODEX_THREAD_ID: 'private-revocation-agent-fixture' });
  const result = await running.closed;
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'B26_PERSON_CHANNEL');
  assert.equal(box.calls.length, offset, 'the agent cannot start sign-in, request approval, or revoke remotely');
  assert.equal(deviceRevoked(box, deviceId), 0, 'the real relay device remains active');
  const machine = JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8'));
  assert.deepEqual(machine.devices.map(device => device.deviceId), [deviceId], 'the local roster remains trusted');
});


test('device revocation chooses a different paired approver [H17,E16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const target = await enrollProtocolPhone(box);
  const other = await enrollProtocolPhone(box);
  const result = await box.script(`
    const { relayMachineContext } = await import(${JSON.stringify(new URL('../src/shell/relay.js', import.meta.url).href)});
    const { phoneProposal } = await import(${JSON.stringify(new URL('../src/shell/relay-phone.js', import.meta.url).href)});
    const proposal = await phoneProposal(relayMachineContext(process.cwd()), 'revoke-device', ${JSON.stringify(target)});
    process.stdout.write(JSON.stringify({ approver: proposal.context.device, target: proposal.context.target }));
  `);
  assert.equal(result.code, 0);
  assert.deepEqual(result.document, { approver: other, target }, 'the target cannot approve its own revocation even when it is first in the roster');
});

test('a fresh sign-in to another account cannot revoke the saved phone [H17,E16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const deviceId = await enrollProtocolPhone(box);
  const sessionsBefore = activeSessionCount(box);
  const offset = box.calls.length;
  box.providerState.accountID = 8;
  const running = box.startCli(['relay', 'revoke', deviceId]);
  const result = await running.closed;
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'DEVICE_ACCOUNT');
  assert.equal(box.calls.slice(offset).some(call => call.method === 'DELETE' && call.path === '/api/v1/devices/' + deviceId), false,
    'the account mismatch is refused before a device deletion request');
  assert.equal(deviceRevoked(box, deviceId), 0);
  assert.equal(activeSessionCount(box), sessionsBefore, 'the mismatched fresh session is also cleaned up');
  const machine = JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8'));
  assert.deepEqual(machine.devices.map(device => device.deviceId), [deviceId]);
});

test('declining fresh revocation sign-in preserves the paired phone [H17,E16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const deviceId = await enrollProtocolPhone(box);
  const sessionsBefore = activeSessionCount(box);
  box.providerState.deviceDeclined = true;
  const running = box.startCli(['relay', 'revoke', deviceId]);
  const result = await running.closed;
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'DEVICE_REVOKE_CANCELLED');
  assert.equal(deviceRevoked(box, deviceId), 0);
  assert.equal(activeSessionCount(box), sessionsBefore);
});
