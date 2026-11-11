/** Pair a private protocol phone through real OAuth, MAC authentication and relay HTTP [H17]. */
import assert from 'node:assert/strict';

/** Enroll a disposable device without launching Chrome for native management tests. */
export async function enrollProtocolPhone(box) {
  const result = await box.script(`
    const { relayMachineContext, relayMachineSignIn, relayDeviceRequest, revokeRelayPersonSession } = await import(${JSON.stringify(new URL('../../../../../packages/link/index.js', import.meta.url).href)});
    const { beginDeviceEnrollment, acceptDeviceEnrollment } = await import(${JSON.stringify(new URL('../../../../../packages/link/index.js', import.meta.url).href)});
    const { createDeviceKeys, signDeviceEnrollment } = await import(${JSON.stringify(new URL('../../../../../packages/keys/index.js', import.meta.url).href)});
    const sink = { isTTY: false, write() {} };
    const io = { cwd: process.cwd(), personChannel: 'terminal', stdout: sink, stderr: sink, say() {}, err() {} };
    const state = relayMachineContext(process.cwd());
    const session = await relayMachineSignIn(state.url, io);
    let deviceId;
    try {
      const phone = await createDeviceKeys();
      const pending = beginDeviceEnrollment(state.board, session);
      const path = '/api/v1/devices/enrollments/' + pending.locator;
      await relayDeviceRequest(session, path, { method: 'POST', body: {} }, io);
      const enrollment = await signDeviceEnrollment(pending.secret, {
        v: 1, account: session.account, locator: pending.locator, deviceId: phone.deviceId,
        publicKey: phone.publicKey, label: 'Protocol phone fixture', createdAt: new Date().toISOString(),
      });
      await relayDeviceRequest(session, path, { method: 'PUT', body: enrollment }, io);
      const reply = await relayDeviceRequest(session, path, {}, io);
      const device = await acceptDeviceEnrollment(reply.enrollment);
      await relayDeviceRequest(session, '/api/v1/devices/' + device.deviceId, { method: 'POST', body: {} }, io);
      await relayDeviceRequest(session, path, { method: 'DELETE' }, io);
      deviceId = device.deviceId;
    } finally { await revokeRelayPersonSession(session, io); }
    process.stdout.write(JSON.stringify({ deviceId }));
  `);
  assert.equal(result.code, 0, 'the private authenticated protocol enrollment completes');
  assert.match(result.document.deviceId, /^device-[0-9a-f]{32}$/u);
  return result.document.deviceId;
}
