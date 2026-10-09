/** Device-only board keys, kept outside repositories and relay requests [H1,H15,H17]. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodeBoardKey, encodeBoardKey } from './seal.js';
import { Refused } from './refused.js';

/** Validate a persistent board identity before using it as a file or credential name. */
function identity(boardId) {
  if (typeof boardId !== 'string' || !/^[0-9a-f]{32}$/.test(boardId)) throw new Refused('BAD_BOARD', 'use this board\'s persistent identifier');
  return boardId;
}

/** Locate the private fallback without putting a board key in a repository. */
function keyFile(boardId) {
  return join(process.env.PULLBOARD_HOME || join(homedir(), '.pullboard'), 'relay-keys', identity(boardId) + '.key');
}

/** Probe an available operating-system credential service without requiring a particular shell. */
function keychain() {
  if (process.platform === 'darwin') {
    const probe = spawnSync('security', ['list-keychains'], { encoding: 'utf8', timeout: 5000 });
    if (probe.status === 0) return 'security';
  } else if (process.platform === 'linux') {
    const probe = spawnSync('secret-tool', ['search', 'application', 'pullboard-probe'], { encoding: 'utf8', timeout: 5000 });
    if (!probe.error && [0, 1].includes(probe.status) && !probe.stderr) return 'secret-tool';
  }
  return null;
}

/** Save a generated key in the keychain, or atomically in an owner-only fallback file. */
export function storeBoardKey(boardId, key) {
  const id = identity(boardId);
  const encoded = encodeBoardKey(key);
  const service = keychain();
  if (service) {
    // security's interactive mode receives the key through a pipe, never process arguments.
    const saved = spawnSync(service, service === 'security' ? ['-i']
      : ['store', '--label=Pullboard board key', 'application', 'pullboard', 'board', id], {
      encoding: 'utf8', timeout: 10000,
      input: service === 'security' ? `add-generic-password -U -a ${id} -s pullboard.board-key -w ${encoded}\n` : encoded,
    });
    if (saved.status !== 0) throw new Refused('RELAY_KEYCHAIN', 'unlock the system keychain and run pullboard relay on again');
    // Interactive security may exit successfully after a failed command; check the stored value.
    if (service === 'security') {
      const found = spawnSync(service, ['find-generic-password', '-a', id, '-s', 'pullboard.board-key', '-w'], { encoding: 'utf8', timeout: 10000 });
      if (found.status !== 0 || found.stdout.trim() !== encoded) throw new Refused('RELAY_KEYCHAIN', 'unlock the system keychain and run pullboard relay on again');
    }
    return 'keychain';
  }
  const file = keyFile(id);
  const directory = join(file, '..');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new Refused('RELAY_KEY_STORAGE', 'use an owner-only relay-keys directory with mode 700');
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, encoded + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
  return 'file';
}

/** Read a board key only from this device's private file or operating-system keychain. */
export function readBoardKey(boardId) {
  const id = identity(boardId);
  const file = keyFile(id);
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Refused('RELAY_KEY_STORAGE', 'restore the board key as an owner-only regular file with mode 600');
    try {
      return decodeBoardKey(readFileSync(file, 'utf8').trim());
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
      throw new Refused('RELAY_KEY_MISSING', 'the board key is unreadable in this shell (' + error.code + '); run this command where the key is available, or pair this device');
    }
  }
  const service = keychain();
  if (service) {
    const args = service === 'security'
      ? ['find-generic-password', '-a', id, '-s', 'pullboard.board-key', '-w']
      : ['lookup', 'application', 'pullboard', 'board', id];
    const found = spawnSync(service, args, { encoding: 'utf8', timeout: 10000 });
    if (found.status === 0) return decodeBoardKey(found.stdout.trim());
  }
  throw new Refused('RELAY_KEY_MISSING', 'the board key is missing on this device; run this command where the key is available, or pair this device');
}

/** Remove the device key after a successful unlink, leaving all local board records untouched. */
export function forgetBoardKey(boardId, storage) {
  const id = identity(boardId);
  const service = keychain();
  if (!service && storage === 'keychain') throw new Refused('RELAY_KEYCHAIN', 'unlock the system keychain and run pullboard relay off again to finish forgetting its key');
  if (service) {
    const removed = spawnSync(service, service === 'security'
      ? ['delete-generic-password', '-a', id, '-s', 'pullboard.board-key']
      : ['clear', 'application', 'pullboard', 'board', id], { encoding: 'utf8', timeout: 10000 });
    const absent = service === 'security' ? removed.status === 44 : removed.status === 1 && !removed.stderr;
    if (removed.status !== 0 && !absent) throw new Refused('RELAY_KEYCHAIN', 'unlock the system keychain and run pullboard relay off again to finish forgetting its key');
  }
  rmSync(keyFile(id), { force: true });
}
