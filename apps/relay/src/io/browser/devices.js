/** Keep the phone's non-extractable key in IndexedDB and receive only locally unwrapped keys [H5,H17]. */
import {
  createDeviceKeys,
  signDeviceEnrollment,
  unwrapDeviceBoardKey,
} from './device-keys.js';
import { encodeBoardKey } from './seal.js';
import { ENGINE_VERSION } from './engine.js';
import { Refused } from './refused.js';
import {
  approvalContext,
  openApproval,
  sealApproval,
  verifyApprovalIntent,
} from './relay-approval.js';
import { devicePublicKey } from './device-keys.js';
import {
  approvalCardText,
  approvalNames,
  deletedText,
  phoneApprovalStatus,
  forgetPhoneApprovals,
} from '../../logic/browser/card.js';
import { withBrowserDeadline } from '../../logic/browser/deadline.js';
import { readExcludedInventories } from '../../logic/browser/excluded.js';

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

/** Close a late IndexedDB open instead of retaining a key connection after the caller timed out. */
function openDeviceDatabase(signal) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('pullboard-relay-device-v1', 1);
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    request.onupgradeneeded = () => {
      if (signal.aborted) request.transaction.abort();
      else request.result.createObjectStore('keys');
    };
    request.onsuccess = () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { request.result.close(); reject(signal.reason); }
      else resolve(request.result);
    };
    request.onerror = () => {
      signal.removeEventListener('abort', abort);
      reject(new Refused('DEVICE_STORAGE', 'Enable IndexedDB before pairing this phone.'));
    };
  });
}

/** Bound opening and completing a private key transaction, aborting that transaction on expiry. */
async function withDeviceStore(mode, action) {
  if (!globalThis.indexedDB) throw new Refused('DEVICE_STORAGE', 'Use a secure browser with IndexedDB enabled to pair this phone.');
  return withBrowserDeadline(async signal => {
    const db = await openDeviceDatabase(signal);
    try {
      if (signal.aborted) throw signal.reason;
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('keys', mode);
        const abort = () => { try { transaction.abort(); } catch (error) { if (error.name !== 'InvalidStateError') reject(error); } };
        signal.addEventListener('abort', abort, { once: true });
        const request = action(transaction.objectStore('keys'));
        let result;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => { signal.removeEventListener('abort', abort); resolve(result); };
        transaction.onerror = transaction.onabort = () => {
          signal.removeEventListener('abort', abort);
          reject(new Refused('DEVICE_STORAGE', 'Device storage did not finish. Open this page again to retry.'));
        };
      });
    } finally { db.close(); }
  }, { code: 'DEVICE_STORAGE', message: 'Device storage did not answer. Open this page again to retry.' });
}

/** Complete one bounded private key transaction before the connection is closed or the page continues. */
async function deviceStorage(value) {
  const result = await withDeviceStore(value === undefined ? 'readonly' : 'readwrite',
    store => value === undefined ? store.get('device') : store.put(value, 'device'));
  return value === undefined ? result ?? null : value;
}

/** Erase a removed browser's private key with the same bounded, abortable storage operation. */
export async function forgetDevice() {
  if (globalThis.indexedDB) await withDeviceStore('readwrite', store => store.delete('device'));
}

/** Send a public enrollment without exposing private material; return true once new pairing delivers keys. */
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
    device = { ...await withBrowserDeadline(() => createDeviceKeys()), account: identity.account, locator };
    await deviceStorage(device);
  }
  const body = await withBrowserDeadline(() => signDeviceEnrollment(secret, { v: 1, account: identity.account, locator,
    deviceId: device.deviceId, publicKey: device.publicKey, label: 'Phone browser', createdAt: new Date().toISOString() }));
  await documentAt('/api/v1/devices/enrollments/' + locator, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  sessionStorage.removeItem(PENDING);
  // Keep the page open while the foreground Mac authenticates the enrollment and delivers keys.
  while (Date.now() < pending.expires) {
    try {
      const response = await documentAt('/api/v1/devices/' + device.deviceId + '/boards');
      if (response.wraps.length) return true;
    } catch (error) { if (error.code !== 'DEVICE_NOT_ENROLLED') throw error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Refused('DEVICE_PAIR_EXPIRED', 'Keep the Mac setup command open and run pullboard relay on --all for a fresh code.');
}

/** Distinguish an enrolled browser with no grants from one that has never been paired to this account. */
export async function deviceBoardKeyState(documentAt) {
  let device;
  try { device = await deviceStorage(); }
  catch (error) { if (error.code === 'DEVICE_STORAGE') return { keys: {}, paired: false, failure: error.message }; throw error; }
  if (!device) {
    // Storage is empty: the relay may still know this browser session as a device that was paired before.
    let known = false;
    try { known = (await documentAt('/api/v1/devices/session')).knownDevice === true; } catch { /* Without the session fact the plain never-paired wording stays. */ }
    return { keys: {}, paired: false, knownDevice: known };
  }
  const identity = await documentAt('/api/v1/devices/session');
  if (identity.account !== device.account) return { keys: {}, paired: false };
  let response;
  try { response = await documentAt('/api/v1/devices/' + device.deviceId + '/boards'); }
  catch (error) { if (error.code === 'DEVICE_NOT_ENROLLED') return { keys: {}, paired: false }; throw error; }
  const keys = {};
  for (const row of response.wraps) {
    if (!/^[0-9a-f]{32}$/u.test(row.board ?? '') || row.engine !== ENGINE_VERSION || typeof row.wrapped !== 'string') {
      throw new Refused('DEVICE_WRAP_AUTH', 'Upgrade this phone to read the linked board engine, or pair again.');
    }
    let envelope;
    try { envelope = JSON.parse(atob(row.wrapped.replaceAll('-', '+').replaceAll('_', '/'))); }
    catch { throw new Refused('DEVICE_WRAP_AUTH', 'The wrapped board key could not be authenticated. Pair again.'); }
    keys[row.board] = encodeBoardKey(await withBrowserDeadline(() => unwrapDeviceBoardKey(device.privateKey, envelope,
      { board: row.board, device: device.deviceId, engine: ENGINE_VERSION })));
  }
  return { keys, paired: true };
}

/** Preserve the key-only adapter for callers that do not display the browser's pairing state. */
export async function deviceBoardKeys(documentAt) {
  return (await deviceBoardKeyState(documentAt)).keys;
}

/** Keep the private device key inside the device module while opening the optional excluded-board list. */
export async function deviceExcludedBoards(documentAt) {
  let device;
  try { device = await deviceStorage(); }
  catch (error) { if (error.code !== 'DEVICE_STORAGE') throw error; }
  return readExcludedInventories(documentAt, device);
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
export async function installPhoneApprovals(documentAt, boardKeys, onApproved, signal) {
  if (document.getElementById('phone-approvals')) return;
  let device = await deviceStorage();
  if (!device || signal?.aborted) return;
  const panel = phoneApprovalStatus(document, 'Checking requests from your computer…');
  if (!panel) return;
  const active = new Set();
  let stopped = false;
  let timer;
  /** Release the private device key and pending cards when this page loses relay access. */
  function stop() { stopped = true; clearTimeout(timer); device = null; forgetPhoneApprovals(document); }
  signal?.addEventListener('abort', stop, { once: true });
  /** Refresh pending metadata without approving it or replacing a button whose request is in flight. */
  async function refresh() {
    if (stopped) return;
    try {
      const response = await documentAt('/api/v1/devices/' + device.deviceId + '/approvals');
      if (stopped) return;
      phoneApprovalStatus(document, null);
      delete panel.dataset.error;
      const ids = new Set(response.approvals.map(value => value.context.id));
      for (const child of [...panel.children]) if (child.dataset.request && !ids.has(child.dataset.request) && !active.has(child.dataset.request)) child.remove();
      for (const row of response.approvals) {
        const context = approvalContext(row.context);
        if (context.device !== device.deviceId || context.account !== device.account || Date.now() >= context.expires ||
            [...panel.children].some(child => child.dataset.request === context.id)) continue;
        const raw = boardKeys[context.publisher];
        if (!raw) continue;
        const key = Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - raw.length % 4) % 4)), char => char.charCodeAt(0));
        const envelope = await withBrowserDeadline(() => verifyApprovalIntent(key, approvalDocument(row.sealed)), { signal });
        const intent = await withBrowserDeadline(() => openApproval(device.privateKey, envelope, context, 'intent'), { signal });
        if (stopped) return;
        if (JSON.stringify(approvalContext(intent.context)) !== JSON.stringify(context)) throw new Refused('PHONE_APPROVAL_AUTH', 'The displayed request differs from its sealed action.');
        const replyKey = devicePublicKey(intent.replyKey);
        const card = document.createElement('div'); card.className = 'phone-approval'; card.dataset.request = context.id;
        const names = approvalNames(intent, context);
        const words = approvalCardText(context, names);
        const text = document.createElement('p'); text.className = 'phone-approval-title'; text.textContent = words.title;
        const detail = document.createElement('p'); detail.className = 'phone-approval-detail'; detail.textContent = words.detail;
        const button = document.createElement('button'); button.type = 'button'; button.id = 'phone-approve-' + context.id;
        button.textContent = context.action === 'link' ? 'Link project' : context.action === 'delete-board' ? 'Delete relay copy' : 'Approve revocation';
        /** Issue once on this tap, then encrypt the result to the native command's private RAM reply key. */
        button.onclick = async () => {
          if (stopped || active.has(context.id)) return;
          active.add(context.id); button.disabled = true;
          try {
            const authorized = await documentAt('/api/v1/devices/approvals/' + context.id + '/authorize', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
            });
            const encrypted = await withBrowserDeadline(() => sealApproval(authorized.result, replyKey, context, 'reply'), { signal });
            const response = btoa(JSON.stringify(encrypted)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
            await documentAt('/api/v1/devices/approvals/' + context.id + '/complete', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response }),
            });
            if (context.action === 'delete-board' && authorized.result?.deleted === context.board) {
              const done = document.createElement('p'); done.setAttribute('role', 'status'); done.textContent = deletedText(names);
              delete card.dataset.request; card.className = 'phone-approval phone-approval-done'; card.replaceChildren(done);
            } else card.remove();
            await onApproved(context);
          } catch (error) { text.textContent = 'Approval failed: ' + (error instanceof Refused ? error.message : 'Request the action again from the Mac.'); }
          finally { active.delete(context.id); }
        };
        card.append(text, detail, button); panel.append(card);
      }
    } catch (error) {
      if (stopped) return;
      if (error?.code === 'DEVICE_NOT_ENROLLED') phoneApprovalStatus(document, null);
      else {
        panel.setAttribute('data-error', 'Approval requests are unavailable. Retry from the Mac.');
        phoneApprovalStatus(document, 'Requests from your computer did not load. They will retry.');
      }
    } finally { if (!stopped) timer = setTimeout(refresh, 1000); }
  }
  addEventListener('pagehide', stop, { once: true });
  await refresh();
}
