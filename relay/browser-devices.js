/** Keep the phone's non-extractable key in IndexedDB and receive only locally unwrapped keys [H5,H17]. */
import { createDeviceKeys, signDeviceEnrollment, unwrapDeviceBoardKey } from './device-keys.js';
import { encodeBoardKey } from './seal.js';
import { ENGINE_VERSION } from './engine.js';
import { Refused } from './refused.js';

const PENDING = 'pullboard.relay.device-pair.v1';

/** Remove the secret fragment before sign-in or any request and retain it only on this device. */
export function rememberDevicePairing() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (!fragment.has('device')) return;
  const code = fragment.get('device');
  if (!/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u.test(code ?? '')) throw new Refused('DEVICE_PAIR_CODE', 'Open a fresh one-time phone pairing link from the Mac.');
  try { sessionStorage.setItem(PENDING, JSON.stringify({ code, expires: Date.now() + 600_000 })); }
  catch { throw new Refused('DEVICE_STORAGE', 'Enable device storage before pairing this phone.'); }
  history.replaceState(null, '', location.pathname + location.search);
}

/** Complete one IndexedDB transaction before its connection is closed or the page continues. */
async function deviceStorage(value) {
  if (!globalThis.indexedDB) throw new Refused('DEVICE_STORAGE', 'Use a secure browser with IndexedDB enabled to pair this phone.');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pullboard-relay-device-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Refused('DEVICE_STORAGE', 'Enable IndexedDB before pairing this phone.'));
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('keys', value === undefined ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('keys');
      const request = value === undefined ? store.get('device') : store.put(value, 'device');
      let result;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(value === undefined ? result ?? null : value);
      transaction.onerror = transaction.onabort = () => reject(new Refused('DEVICE_STORAGE', 'The phone could not retain its private key. Enable device storage and pair again.'));
    });
  } finally { db.close(); }
}

/** Send a public authenticated enrollment while the private key and QR secret remain on the phone. */
export async function enrollPhone(documentAt) {
  rememberDevicePairing();
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING)); } catch { return; }
  if (!pending) return;
  if (!/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u.test(pending.code ?? '') || Date.now() >= pending.expires) {
    sessionStorage.removeItem(PENDING);
    throw new Refused('DEVICE_PAIR_EXPIRED', 'Run pullboard relay on --all at the Mac for a fresh phone pairing link.');
  }
  const [locator, secret] = pending.code.split('.');
  const identity = await documentAt('/api/v1/devices/session');
  let device = await deviceStorage();
  if (device?.locator !== locator || device.account !== identity.account) {
    device = { ...await createDeviceKeys(), account: identity.account, locator };
    await deviceStorage(device);
  }
  const body = await signDeviceEnrollment(secret, { v: 1, account: identity.account, locator,
    deviceId: device.deviceId, publicKey: device.publicKey, label: 'Phone browser', createdAt: new Date().toISOString() });
  await documentAt('/api/v1/devices/enrollments/' + locator, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  sessionStorage.removeItem(PENDING);
  // Keep the page open while the foreground Mac authenticates the enrollment and delivers keys.
  while (Date.now() < pending.expires) {
    try {
      const response = await documentAt('/api/v1/devices/' + device.deviceId + '/boards');
      if (response.wraps.length) return;
    } catch (error) { if (error.code !== 'DEVICE_NOT_ENROLLED') throw error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Refused('DEVICE_PAIR_EXPIRED', 'Keep the Mac setup command open and run pullboard relay on --all for a fresh code.');
}

/** Fetch only the signed-in account's grants and authenticate their context with the stored private key. */
export async function deviceBoardKeys(documentAt) {
  let device;
  try { device = await deviceStorage(); }
  catch (error) { if (error.code === 'DEVICE_STORAGE') return {}; throw error; }
  if (!device) return {};
  const identity = await documentAt('/api/v1/devices/session');
  if (identity.account !== device.account) return {};
  let response;
  try { response = await documentAt('/api/v1/devices/' + device.deviceId + '/boards'); }
  catch (error) { if (error.code === 'DEVICE_NOT_ENROLLED') return {}; throw error; }
  const keys = {};
  for (const row of response.wraps) {
    if (!/^[0-9a-f]{32}$/u.test(row.board ?? '') || row.engine !== ENGINE_VERSION || typeof row.wrapped !== 'string') {
      throw new Refused('DEVICE_WRAP_AUTH', 'Upgrade this phone to read the linked board engine, or pair again.');
    }
    let envelope;
    try { envelope = JSON.parse(atob(row.wrapped.replaceAll('-', '+').replaceAll('_', '/'))); }
    catch { throw new Refused('DEVICE_WRAP_AUTH', 'The wrapped board key could not be authenticated. Pair again.'); }
    keys[row.board] = encodeBoardKey(await unwrapDeviceBoardKey(device.privateKey, envelope,
      { board: row.board, device: device.deviceId, engine: ENGINE_VERSION }));
  }
  return keys;
}
