/** Keep the phone's non-extractable key in IndexedDB and receive only locally unwrapped keys [H5,H17]. */
import { createDeviceKeys, signDeviceEnrollment, unwrapDeviceBoardKey } from './device-keys.js';
import { encodeBoardKey } from './seal.js';
import { ENGINE_VERSION } from './engine.js';
import { Refused } from './refused.js';
import { approvalContext, openApproval, sealApproval, verifyApprovalIntent } from './relay-approval.js';
import { devicePublicKey } from './device-keys.js';

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

/** Decode only bounded approval transport; keys and plaintext grants never enter device storage. */
function approvalDocument(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32000}$/u.test(value)) throw new Refused('PHONE_APPROVAL_AUTH', 'Request a fresh native approval.');
  try {
    const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new Refused('PHONE_APPROVAL_AUTH', 'The native approval could not be read. Request it again.'); }
}

/** Show exact paired native intent and approve only on one explicit phone tap. */
export async function installPhoneApprovals(documentAt, boardKeys, onApproved) {
  if (document.getElementById('phone-approvals')) return;
  const device = await deviceStorage();
  if (!device) return;
  const panel = document.createElement('section');
  panel.className = 'card-panel'; panel.id = 'phone-approvals';
  panel.setAttribute('aria-label', 'Requests from your Mac');
  document.querySelector('main').prepend(panel);
  const active = new Set();
  let stopped = false;
  let timer;
  /** Refresh pending metadata without approving it or replacing a button whose request is in flight. */
  async function refresh() {
    if (stopped) return;
    try {
      const response = await documentAt('/api/v1/devices/' + device.deviceId + '/approvals');
      const ids = new Set(response.approvals.map(value => value.context.id));
      for (const child of [...panel.children]) if (!ids.has(child.dataset.request) && !active.has(child.dataset.request)) child.remove();
      for (const row of response.approvals) {
        const context = approvalContext(row.context);
        if (context.device !== device.deviceId || context.account !== device.account || Date.now() >= context.expires ||
            [...panel.children].some(child => child.dataset.request === context.id)) continue;
        const raw = boardKeys[context.publisher];
        if (!raw) continue;
        const key = Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - raw.length % 4) % 4)), char => char.charCodeAt(0));
        const envelope = await verifyApprovalIntent(key, approvalDocument(row.sealed));
        const intent = await openApproval(device.privateKey, envelope, context, 'intent');
        if (JSON.stringify(approvalContext(intent.context)) !== JSON.stringify(context)) throw new Refused('PHONE_APPROVAL_AUTH', 'The displayed request differs from its sealed action.');
        const replyKey = devicePublicKey(intent.replyKey);
        const card = document.createElement('div'); card.className = 'phone-approval'; card.dataset.request = context.id;
        const text = document.createElement('p');
        text.textContent = context.command + ' · board ' + context.board + ' · target ' + context.target + ' · machine ' + context.machine + ' · expires ' + new Date(context.expires).toISOString();
        const button = document.createElement('button'); button.type = 'button'; button.id = 'phone-approve-' + context.id;
        button.textContent = context.action === 'link' ? 'Link project' : context.action === 'delete-board' ? 'Delete relay copy' : 'Approve revocation';
        /** Issue once on this tap, then encrypt the result to the native command's private RAM reply key. */
        button.onclick = async () => {
          if (active.has(context.id)) return;
          active.add(context.id); button.disabled = true;
          try {
            const authorized = await documentAt('/api/v1/devices/approvals/' + context.id + '/authorize', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
            });
            const encrypted = await sealApproval(authorized.result, replyKey, context, 'reply');
            const response = btoa(JSON.stringify(encrypted)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
            await documentAt('/api/v1/devices/approvals/' + context.id + '/complete', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response }),
            });
            card.remove(); await onApproved();
          } catch (error) { text.textContent = 'Approval failed: ' + (error instanceof Refused ? error.message : 'Request the action again from the Mac.'); }
          finally { active.delete(context.id); }
        };
        card.append(text, button); panel.append(card);
      }
    } catch (error) {
      if (error?.code !== 'DEVICE_NOT_ENROLLED') panel.setAttribute('data-error', 'Approval requests are unavailable. Retry from the Mac.');
    } finally { if (!stopped) timer = setTimeout(refresh, 1000); }
  }
  addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); }, { once: true });
  await refresh();
}
