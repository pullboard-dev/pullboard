/** Owner-only machine metadata, authenticated device roster and one-use enrollment [H5,H15,H17]. */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { authenticateDeviceEnrollment, devicePublicKey, wrapDeviceBoardKey } from './relay-device-keys.js';
import { scrubLegacyPersonSessions } from './relay-key.js';
import { approvalContext } from './relay-approval.js';
import { createPairingCode } from './pairing.js';
import { Refused } from './refused.js';

const DEVICE = /^device-[0-9a-f]{32}$/u;

/** Locate only the private machine directory; repositories never carry these credentials. */
function directory() {
  return join(process.env.PULLBOARD_HOME || join(homedir(), '.pullboard'), 'relay-machine');
}

/** Refuse symlinks, non-owner files or broader permissions before reading machine secrets. */
function privateEntry(path, folder = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (folder ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Refused('RELAY_MACHINE_STORAGE', 'Restore owner-only relay-machine storage: directory mode 700, files mode 600.');
  }
}

/** Return the empty durable format without sharing mutable arrays between callers. */
function emptyState() {
  return { v: 2, autoLink: false, owner: null, machine: 'machine-' + randomUUID(), devices: [], excluded: [], pending: null, revocations: [], approvals: [] };
}

/** Validate machine metadata before any mutation can overwrite the trusted device roster. */
function validate(state) {
  if (!state || ![1, 2].includes(state.v) || typeof state.autoLink !== 'boolean' || !Array.isArray(state.devices) ||
      !Array.isArray(state.excluded) || !Array.isArray(state.revocations) || state.excluded.some(root => typeof root !== 'string') ||
      state.devices.some(device => !DEVICE.test(device?.deviceId ?? '') || typeof device.account !== 'string' || typeof device.url !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(device.fingerprint ?? '') || typeof device.label !== 'string' || typeof device.createdAt !== 'string') ||
      (state.session != null && (!state.session || !/^ps_[A-Za-z0-9_-]{43}$/u.test(state.session.token ?? '') ||
        typeof state.session.account !== 'string' || typeof state.session.url !== 'string')) ||
      (state.pending !== null && (!state.pending || !/^[A-Za-z0-9_-]{43}$/u.test(state.pending.secret ?? '') ||
        !/^[A-Za-z0-9_-]{22}$/u.test(state.pending.locator ?? '') || typeof state.pending.account !== 'string' ||
        typeof state.pending.url !== 'string' || !Number.isSafeInteger(state.pending.expires)))) {
    throw new Refused('RELAY_MACHINE_STORAGE', 'Restore supported machine relay settings without replacing the trusted device list.');
  }
  if (state.v === 2 && (!/^[A-Za-z0-9_-]{1,128}$/u.test(state.machine ?? '') || !Array.isArray(state.approvals) ||
      (state.owner !== null && (!state.owner || typeof state.owner.account !== 'string' || !state.owner.account ||
        typeof state.owner.url !== 'string' || !state.owner.url || Object.keys(state.owner).some(key => !['account', 'url'].includes(key)))))) {
    throw new Refused('RELAY_MACHINE_STORAGE', 'Restore the supported machine identity and phone-link metadata, or sign in again explicitly.');
  }
  for (const entry of state.approvals ?? []) {
    try {
      const context = approvalContext(entry.context);
      if (context.action !== 'link' || typeof entry.root !== 'string' || typeof entry.publisherRoot !== 'string' ||
          typeof entry.published !== 'boolean' || typeof entry.sealed !== 'string' || !/^[A-Za-z0-9_-]{1,40000}$/u.test(entry.sealed) ||
          !/^[A-Za-z0-9_-]{43}$/u.test(entry.replyKey?.d ?? '') ||
          Object.keys(entry).some(key => !['root', 'publisherRoot', 'context', 'sealed', 'replyKey', 'published'].includes(key))) throw new Error('metadata');
      const { d, key_ops, ...publicKey } = entry.replyKey;
      devicePublicKey(publicKey);
    } catch { throw new Refused('RELAY_MACHINE_STORAGE', 'Restore the pending phone-link proposal; person-action replies must stay in memory.'); }
  }
  for (const device of state.devices) devicePublicKey(device.publicKey);
  return state;
}

/** Read the durable machine state without creating a directory or touching the network. */
function readState() {
  const folder = directory();
  if (!existsSync(folder)) return emptyState();
  privateEntry(folder, true);
  const file = join(folder, 'state.json');
  if (!existsSync(file)) return emptyState();
  privateEntry(file);
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Refused('RELAY_MACHINE_STORAGE', 'Restore valid machine relay settings before signing in or pairing again.'); }
  return validate(state);
}

/** Scrub legacy person sessions before returning settings to any native or agent command. */
export function readRelayMachine() {
  scrubLegacyPersonSessions();
  const state = readState();
  const folder = directory();
  const fragments = existsSync(folder) && readdirSync(folder).some(name => /^state\.[0-9]+\.[0-9a-f-]+\.tmp$/u.test(name));
  if (state.v === 1 || state.session != null || fragments) {
    updateRelayMachine(() => {});
    return readState();
  }
  return state;
}

/** Serialize cross-process read-modify-write and atomically replace the private machine file. */
export function updateRelayMachine(mutate) {
  const folder = directory();
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  privateEntry(folder, true);
  const lock = join(folder, 'lock.sqlite');
  try { closeSync(openSync(lock, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  privateEntry(lock);
  const db = new DatabaseSync(lock);
  let temporary;
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    db.exec('CREATE TABLE IF NOT EXISTS machine_lock (id INTEGER PRIMARY KEY)');
    db.exec('BEGIN IMMEDIATE');
    // A crashed legacy writer may have left a complete person session beside state.json.
    for (const name of readdirSync(folder)) {
      if (/^state\.[0-9]+\.[0-9a-f-]+\.tmp$/u.test(name)) rmSync(join(folder, name), { force: true });
    }
    const state = readState();
    state.owner ??= state.session ? { account: state.session.account, url: state.session.url } : null;
    state.machine ??= 'machine-' + randomUUID();
    state.approvals ??= [];
    state.v = 2;
    delete state.session;
    const result = mutate(state);
    delete state.session;
    validate(state);
    temporary = join(folder, `state.${process.pid}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(state) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, join(folder, 'state.json'));
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* No transaction may have started. */ }
    throw error;
  } finally {
    db.close();
    if (temporary) rmSync(temporary, { force: true });
  }
}

/** Persist a fresh ten-minute pairing secret locally before publishing its public locator. */
export function beginDeviceEnrollment(board, session, now = Date.now()) {
  const code = createPairingCode(board);
  const pending = { ...code, account: session.account, url: session.url, expires: now + 10 * 60_000 };
  updateRelayMachine(state => { state.pending = pending; });
  return pending;
}

/** Authenticate before recording, and consume the local secret atomically so no relay replay can enroll twice. */
export async function acceptDeviceEnrollment(value, now = Date.now()) {
  const pending = readRelayMachine().pending;
  if (!pending || now >= pending.expires) throw new Refused('DEVICE_PAIR_EXPIRED', 'Run pullboard relay on --all again for a fresh pairing link.');
  const device = await authenticateDeviceEnrollment(pending.secret, value, pending);
  return updateRelayMachine(state => {
    if (!state.pending || state.pending.locator !== pending.locator || state.pending.secret !== pending.secret || Date.now() >= state.pending.expires) {
      throw new Refused('DEVICE_PAIR_USED', 'The one-time pairing link was used or expired. Run pullboard relay on --all again.');
    }
    if (state.devices.some(entry => entry.deviceId === device.deviceId)) throw new Refused('DEVICE_EXISTS', 'Use a fresh device key for this pairing link.');
    const recorded = { ...device, account: pending.account, url: pending.url };
    state.devices.push(recorded);
    state.pending = null;
    return recorded;
  });
}

/** Wrap only to a key authenticated into this Mac's roster, never to a relay-returned public key. */
export async function wrapForRecordedDevice(boardKey, context, owner) {
  const device = readRelayMachine().devices.find(entry => entry.deviceId === context.device && entry.account === owner.account && entry.url === owner.url);
  if (!device) throw new Refused('DEVICE_NOT_ENROLLED', 'Pair this device with this Mac before sending it any board keys.');
  const wrapped = await wrapDeviceBoardKey(boardKey, device.publicKey, context);
  const current = readRelayMachine().devices.find(entry => entry.deviceId === context.device && entry.account === owner.account && entry.url === owner.url);
  if (!current || current.fingerprint !== device.fingerprint) throw new Refused('DEVICE_REVOKED', 'This device was revoked while wrapping; pair again before sending keys.');
  return wrapped;
}

/** Stop local wrapping first and retain a durable remote deletion intent until the relay acknowledges it. */
export function removeRecordedDevice(deviceId) {
  if (!DEVICE.test(deviceId ?? '')) throw new Refused('DEVICE_ID', 'Name the paired device id printed by pullboard relay devices.');
  return updateRelayMachine(state => {
    const device = state.devices.find(entry => entry.deviceId === deviceId);
    const queued = state.revocations.find(entry => entry.deviceId === deviceId);
    if (!device && !queued) throw new Refused('DEVICE_NOT_ENROLLED', 'List paired devices with pullboard relay devices, then name one to revoke.');
    state.devices = state.devices.filter(entry => entry.deviceId !== deviceId);
    if (device && !queued) state.revocations.push({ deviceId, account: device.account, url: device.url });
    return queued ?? { deviceId, account: device.account, url: device.url };
  });
}
