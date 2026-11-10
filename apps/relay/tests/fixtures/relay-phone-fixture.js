/** A paired Chrome phone and in-process native approvals for the direct relay fixture: no CLI process [C7,H15,H17]. */
import assert from 'node:assert/strict';
import { acceptDeviceEnrollment } from '../../../../packages/link/index.js';
import { beginDeviceEnrollment } from '../../../../packages/link/index.js';
import { relayDeviceRequest } from '../../../../packages/link/index.js';
import { relayMachineContext } from '../../../../packages/link/index.js';
import { relayMachineSignIn } from '../../../../packages/link/index.js';
import { relayOnAll } from '../../../../packages/link/index.js';
import { relayRevoke } from '../../../../packages/link/index.js';
import { relayRevokeDevice } from '../../../../packages/link/index.js';
import { revokeRelayPersonSession } from '../../../../packages/link/index.js';
import { createDeviceKeys } from '../../../../packages/keys/index.js';
import { signDeviceEnrollment } from '../../../../packages/keys/index.js';
import { registerProject } from '../../../../packages/seats/index.js';
import { startChrome } from '../../../cli/tests/fixtures/relay/browser.js';

/** Poll an actual fixture state transition without retrying the operation under test. */
export async function waitFor(read, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  assert.fail(message);
}

/** Settle with a work promise, or fail naming the stage and what the page showed when a finite hang ceiling passes. */
export async function within(work, ms, stage, diagnose = async () => '') {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(async () => reject(new Error(`${stage} did not finish within ${ms}ms; ${await diagnose().catch(error => 'no diagnosis: ' + error.message)}`)), ms);
  });
  try { return await Promise.race([work, expired]); } finally { clearTimeout(timer); }
}

/**
 * Run the foreground machine setup (relay on --all) in process and pair one real Chrome device through the real relay.
 * Why: the phone needs the one-use pairing the setup publishes, handed over by its typed onPairingURL callback.
 *
 * @param {object} box - A relayDirectFixture.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ chrome: object, setup: object }>} setup is relayOnAll's result.
 */
export async function pairChromePhone(box, t) {
  registerProject(box.root);
  let offer;
  const offered = new Promise(resolveOffer => { offer = resolveOffer; });
  const stop = new AbortController();
  const running = relayOnAll(box.origin, box.io, { onPairingURL: offer, signal: stop.signal });
  let chrome;
  t.after(async () => {
    stop.abort();
    await running.catch(() => {});
    await chrome?.close();
  });
  const pairing = await within(Promise.race([offered, running.then(() => assert.fail('foreground setup publishes a real one-use phone enrollment'))]),
    60_000, 'the foreground setup offering its pairing'); // budget: hang ceiling for sign-in and linking; no throughput claim.
  chrome = await startChrome();
  const session = await within(box.server.phoneSession(), 30_000, 'the independent phone sign-in'); // budget: hang ceiling for one OAuth round trip; no throughput claim.
  assert.equal((await chrome.send('Network.setCookie', { name: 'pb_session', value: session.token, url: box.origin,
    httpOnly: true, sameSite: 'Lax' })).success, true);
  await within(chrome.navigate(pairing.url), 60_000, 'the phone page loading its pairing link'); // budget: hang ceiling for one page load; no throughput claim.
  const setup = await within(running, 60_000, 'the real phone enrollment', () => chrome.evaluate( // budget: hang ceiling for the enrollment handshake; no throughput claim.
    '[location.href, document.readyState, document.body.innerText.slice(0, 400)].join(" | ")'));
  assert.equal(setup.paired, true, 'the real phone enrollment completes native setup');
  assert.equal(setup.failed.length, 0, 'the setup links every registered board');
  await chrome.waitFor("document.querySelector('#phone-approvals') !== null");
  return { chrome, setup };
}

/**
 * Start native token and device revocations in process, each ending with { code, value } or { code: 1, error }.
 * The relay clock moves a day at the end so a revocation a test left waiting expires and the test can finish.
 *
 * @param {object} box - A relayDirectFixture.
 * @param {import('node:test').TestContext} t
 */
export function nativeRevocations(box, t) {
  const started = [];
  t.after(async () => {
    box.server.advance(1);
    await Promise.all(started);
  });
  return {
    start(id) {
      const revoke = id.startsWith('device-') ? relayRevokeDevice : relayRevoke;
      const done = revoke(box.root, id, box.io).then(value => ({ code: 0, value }), error => ({ code: 1, error }));
      started.push(done);
      return done;
    },
  };
}

/** Enroll a disposable device in process, without Chrome, through real OAuth, MAC authentication and relay HTTP. */
export async function enrollProtocolPhone(box) {
  const state = relayMachineContext(box.root);
  const session = await relayMachineSignIn(state.url, box.io);
  let deviceId;
  try {
    const phone = await createDeviceKeys();
    const pending = beginDeviceEnrollment(state.board, session);
    const path = '/api/v1/devices/enrollments/' + pending.locator;
    await relayDeviceRequest(session, path, { method: 'POST', body: {} }, box.io);
    const enrollment = await signDeviceEnrollment(pending.secret, {
      v: 1, account: session.account, locator: pending.locator, deviceId: phone.deviceId,
      publicKey: phone.publicKey, label: 'Protocol phone fixture', createdAt: new Date().toISOString(),
    });
    await relayDeviceRequest(session, path, { method: 'PUT', body: enrollment }, box.io);
    const reply = await relayDeviceRequest(session, path, {}, box.io);
    const device = await acceptDeviceEnrollment(reply.enrollment);
    await relayDeviceRequest(session, '/api/v1/devices/' + device.deviceId, { method: 'POST', body: {} }, box.io);
    await relayDeviceRequest(session, path, { method: 'DELETE' }, box.io);
    deviceId = device.deviceId;
  } finally { await revokeRelayPersonSession(session, box.io); }
  assert.match(deviceId, /^device-[0-9a-f]{32}$/u);
  return deviceId;
}
