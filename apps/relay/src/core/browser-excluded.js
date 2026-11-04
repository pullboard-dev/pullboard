/** Decrypt excluded-board names only on an enrolled device; fresh browsers retain labels/counts [H5,H17]. */
import { unwrapDeviceBoardKey } from './device-keys.js';
import { unseal } from './seal.js';
import { Refused } from './refused.js';
import { ENGINE_VERSION } from './engine.js';
import { withBrowserDeadline } from './browser-deadline.js';

/** Decode only bounded canonical transport bytes before authenticating them on this device. */
function bytes(value, limit) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length > limit) {
    throw new Refused('EXCLUDED_INVENTORY', 'Refresh this browser to read the excluded-board list.');
  }
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Read this signed-in account's metadata and, only with its active device key, its sealed names. */
export async function readExcludedInventories(documentAt, device) {
  const response = await documentAt('/api/v1/devices/exclusions');
  if (!Array.isArray(response.exclusions) || response.exclusions.length > 256) {
    throw new Refused('EXCLUDED_INVENTORY', 'Refresh this browser to read the excluded-board list.');
  }
  const exclusions = response.exclusions.map(entry => {
    if (!entry || !/^[A-Za-z0-9_.-]{1,128}$/u.test(entry.machine ?? '') || typeof entry.label !== 'string'
        || !entry.label.trim() || entry.label.length > 80 || /[\u0000-\u001f\u007f]/u.test(entry.label)
        || !Number.isInteger(entry.count) || entry.count < 1 || entry.count > 256) {
      throw new Refused('EXCLUDED_INVENTORY', 'Refresh this browser to read the excluded-board list.');
    }
    return { machine: entry.machine, label: entry.label, count: entry.count };
  });
  if (!device || !exclusions.length) return exclusions;
  const identity = await documentAt('/api/v1/devices/session');
  if (identity.account !== device.account) return exclusions;
  let wrapped;
  try { wrapped = await documentAt('/api/v1/devices/' + device.deviceId + '/exclusions'); }
  catch (error) { if (error.code === 'DEVICE_NOT_ENROLLED') return exclusions; throw error; }
  if (!Array.isArray(wrapped.exclusions) || wrapped.exclusions.length > 256) {
    throw new Refused('EXCLUDED_INVENTORY', 'Refresh this browser to read the excluded-board list.');
  }
  for (const row of wrapped.exclusions) {
    const entry = exclusions.find(entry => entry.machine === row.machine);
    if (!entry || row.engine !== ENGINE_VERSION || !/^[0-9a-f]{32}$/u.test(row.id ?? '')) {
      throw new Refused('EXCLUDED_INVENTORY', 'Upgrade this browser or refresh its excluded-board list.');
    }
    const envelope = JSON.parse(new TextDecoder().decode(bytes(row.wrapped, 6000)));
    const key = await withBrowserDeadline(() => unwrapDeviceBoardKey(device.privateKey, envelope,
      { board: row.id, device: device.deviceId, engine: row.engine }));
    const plain = await withBrowserDeadline(() => unseal(key, bytes(row.sealed, 131072),
      { boardId: row.id, kind: 'snapshot', sequence: 0 }));
    const value = JSON.parse(new TextDecoder().decode(plain));
    if (value.account !== identity.account || value.machine !== entry.machine || value.label !== entry.label || !Array.isArray(value.names)
        || value.names.length !== entry.count || value.names.some(name => typeof name !== 'string'
          || name.length > 256 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(name)
          || name.split('/').some(part => part === '.' || part === '..'))) {
      throw new Refused('EXCLUDED_INVENTORY', 'Refresh this browser to read the authenticated excluded-board list.');
    }
    entry.names = value.names;
  }
  return exclusions;
}

