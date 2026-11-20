/** Read codemap inputs from sealed in-memory Git trees without creating checkout roots [C7,CD64]. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { fileSystemAdapter } from '../../../../fs/index.js';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

const fs = fileSystemAdapter();
const snapshotsByScope = new AsyncLocalStorage();
const DIRECTORY_MODE = 0o040000;
const SYMLINK_MODE = 0o120000;
const S_IFMT = 0o170000;

/** Normalize Git's octal mode while accepting already-decoded POSIX mode bits. */
function modeBits(mode) {
  if (typeof mode === 'number' && Number.isSafeInteger(mode)) {
    const type = mode & S_IFMT;
    return [0o100000, 0o120000, 0o040000, 0o160000, 0o060000, 0o020000, 0o010000, 0o140000].includes(type) ? mode : 0;
  }
  return typeof mode === 'string' && /^[0-7]{6}$/u.test(mode) ? Number.parseInt(mode, 8) : 0;
}

/** Convert accepted file-like paths to their lexical absolute spelling without resolving symlinks. */
function absolutePath(value) {
  if (value instanceof URL) return resolve(fileURLToPath(value));
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return resolve(Buffer.from(value).toString());
  if (typeof value !== 'string') return null;
  return resolve(value);
}

/** Preserve the caller's path spelling so a virtual-root traversal cannot fall through to host files. */
function rawAbsolutePath(value) {
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value = Buffer.from(value).toString();
  return typeof value === 'string' ? (isAbsolute(value) ? value : `${process.cwd()}${sep}${value}`) : null;
}

/** Validate one repository-relative Git path; no path component may escape its virtual root. */
function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\0')
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** Normalize the map keys used by a snapshot before they can describe filesystem entries. */
function snapshotEntries(snapshot) {
  if (!(snapshot?.entries instanceof Map)) throw new TypeError('cell source snapshot entries must be a Map');
  for (const [file, entry] of snapshot.entries) {
    if (!safeRelative(file) || !entry || typeof entry !== 'object') throw new TypeError('cell source snapshot has an invalid Git entry');
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = snapshot.entries.get(parts.slice(0, index).join('/'));
      if (ancestor && (modeBits(ancestor.mode) & S_IFMT) !== DIRECTORY_MODE) {
        throw new TypeError('cell source snapshot contains a child under a non-directory Git entry');
      }
    }
  }
  if (!(snapshot.files instanceof Map)) throw new TypeError('cell source snapshot files must be a Map');
  for (const [file, bytes] of snapshot.files) {
    if (!safeRelative(file) || !Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('cell source snapshot has invalid blob bytes');
  }
  return snapshot.entries;
}

/** Index every implicit directory once so virtual stat and readdir stay proportional to the queried path. */
function snapshotDirectories(snapshot) {
  const directories = new Set(['']);
  for (const [file, entry] of snapshot.entries) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
    if ((modeBits(entry.mode) & S_IFMT) === DIRECTORY_MODE) directories.add(file);
  }
  return directories;
}

/** Select the deepest virtual snapshot containing an absolute path and return its Git-relative name. */
function locate(value) {
  const absolute = absolutePath(value);
  if (absolute === null) return null;
  const raw = rawAbsolutePath(value);
  let found = null;
  for (const snapshot of snapshotsByScope.getStore()?.values() ?? []) {
    const root = absolutePath(snapshot.root);
    if (root === null) continue;
    const name = relative(root, absolute);
    if (name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) {
      if (raw === root || raw?.startsWith(`${root}${sep}`)) throw pathError('EACCES', raw, 'virtual path escapes its sealed root');
      continue;
    }
    if (!found || root.length > found.root.length) found = { root, name: name.split(sep).join('/'), snapshot };
  }
  return found;
}

/** Return a path's Git entry if it exists, including its non-followed symlink type. */
function exactEntry(snapshot, name) {
  return name === '' ? null : snapshot.entries.get(name) ?? null;
}

/** Find whether any repository entry has this path as a child directory. */
function inferredDirectory(snapshot, name) {
  return snapshot.directories.has(name);
}

/** Refuse traversal through a tracked symlink, regular file or gitlink instead of following host paths. */
function checkAncestors(snapshot, name) {
  const parts = name ? name.split('/') : [];
  for (let index = 1; index < parts.length; index += 1) {
    const parent = parts.slice(0, index).join('/');
    const entry = snapshot.entries.get(parent);
    if (!entry) continue;
    const type = modeBits(entry.mode) & S_IFMT;
    if (type === SYMLINK_MODE || type !== DIRECTORY_MODE) throw pathError('ENOTDIR', parent, 'not a directory');
  }
}

/** Create a Node-shaped filesystem error for a virtual path. */
function pathError(code, path, message) {
  const error = new Error(`${message}, '${path}'`);
  error.code = code;
  error.path = path;
  return error;
}

/** Find the file or inferred directory at one validated virtual path. */
function virtualEntry(located) {
  const { snapshot, name } = located;
  checkAncestors(snapshot, name);
  const entry = exactEntry(snapshot, name);
  if (entry) return { entry, directory: false };
  if (inferredDirectory(snapshot, name)) return { entry: null, directory: true };
  throw pathError('ENOENT', name, 'no such file or directory');
}

let realStatsPrototype = null;
/** The prototype of the file-system adapter's own Stats, read once from this file's real metadata. */
function statsPrototype() {
  realStatsPrototype ??= Object.getPrototypeOf(fs.lstat(fileURLToPath(import.meta.url)));
  return realStatsPrototype;
}

/** Build Stats with authentic POSIX mode predicates and inert timestamps for a sealed Git object. */
function virtualStats(mode, size = 0) {
  const stats = Object.create(statsPrototype());
  const now = new Date(0);
  Object.assign(stats, {
    dev: 0, ino: 0, mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size, blksize: 0, blocks: 0,
    atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
    atime: now, mtime: now, ctime: now, birthtime: now,
  });
  return stats;
}

/** Make a Dirent-shaped record without asking the host filesystem to follow a virtual path. */
function virtualDirent(name, mode, parentPath, encoding) {
  const type = mode & S_IFMT;
  const direntName = encoding === 'buffer' ? Buffer.from(name) : Buffer.from(name).toString(encoding || 'utf8');
  return {
    name: direntName,
    parentPath,
    path: parentPath,
    isFile: () => type === 0o100000,
    isDirectory: () => type === DIRECTORY_MODE,
    isBlockDevice: () => type === 0o060000,
    isCharacterDevice: () => type === 0o020000,
    isSymbolicLink: () => type === SYMLINK_MODE,
    isFIFO: () => type === 0o010000,
    isSocket: () => type === 0o140000,
  };
}

/** Run an action with one or more read-only Git snapshots visible to this async call chain. */
export function withCellSourceSnapshots(snapshots, action) {
  if (typeof action !== 'function') throw new TypeError('cell source snapshot scope needs an action');
  const input = snapshots instanceof Map ? [...snapshots.values()] : Array.isArray(snapshots) ? snapshots : [snapshots];
  const scoped = new Map(snapshotsByScope.getStore() ?? []);
  for (const snapshot of input) {
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.root !== 'string') throw new TypeError('cell source snapshot needs a virtual root');
    snapshotEntries(snapshot);
    const root = absolutePath(snapshot.root);
    if (root === null) throw new TypeError('cell source snapshot root must be a path');
    scoped.set(root, { ...snapshot, root, directories: snapshotDirectories(snapshot) });
  }
  return snapshotsByScope.run(scoped, action);
}

/** Return the scoped snapshot for one virtual checkout root, or null outside a snapshot scope. */
export function cellSourceSnapshot(root) {
  const absolute = absolutePath(root);
  return absolute === null ? null : snapshotsByScope.getStore()?.get(absolute) ?? null;
}

/** Read one regular in-memory Git blob; symlinks are never followed through a virtual checkout. */
export function cellReadFileSync(path, options) {
  const located = locate(path);
  if (!located) return fs.readFile(path, options ?? null);
  const flag = typeof options === 'object' && options !== null ? options.flag : undefined;
  if (flag !== undefined && flag !== 'r' && flag !== 0) throw pathError('EROFS', located.name, 'virtual cell sources are read-only');
  const { entry, directory } = virtualEntry(located);
  if (directory || (modeBits(entry.mode) & S_IFMT) === DIRECTORY_MODE) throw pathError('EISDIR', located.name, 'is a directory');
  const type = modeBits(entry.mode) & S_IFMT;
  if (type === SYMLINK_MODE) throw pathError('ELOOP', located.name, 'refusing to follow a Git symlink');
  if (type !== 0o100000) throw pathError('EISDIR', located.name, 'is not a regular file');
  const bytes = located.snapshot.files.get(located.name);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw pathError('ENOENT', located.name, 'Git blob bytes are unavailable for');
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding && encoding !== 'buffer' ? Buffer.from(bytes).toString(encoding) : Buffer.from(bytes);
}

/** Report a sealed virtual path's existence without traversing a tracked symlink. */
export function cellExistsSync(path) {
  const located = locate(path);
  if (!located) return fs.exists(path);
  try { virtualEntry(located); return true; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

/** Return a no-follow Stats view for one sealed Git entry or inferred directory. */
export function cellLstatSync(path) {
  const located = locate(path);
  if (!located) return fs.lstat(path);
  const { entry, directory } = virtualEntry(located);
  if (directory) return virtualStats(DIRECTORY_MODE);
  const mode = modeBits(entry.mode);
  const bytes = located.snapshot.files.get(located.name);
  return virtualStats(mode, Buffer.isBuffer(bytes) || bytes instanceof Uint8Array ? bytes.byteLength : 0);
}

/** List direct children inferred from Git entries, honoring encoding and withFileTypes options. */
export function cellReaddirSync(path, options) {
  const located = locate(path);
  if (!located) return fs.list(path, options);
  const { entry, directory } = virtualEntry(located);
  if (entry && (modeBits(entry.mode) & S_IFMT) !== DIRECTORY_MODE) throw pathError('ENOTDIR', located.name, 'not a directory');
  if (!directory && located.name !== '' && !entry) throw pathError('ENOTDIR', located.name, 'not a directory');
  const withFileTypes = typeof options === 'object' && options !== null && options.withFileTypes === true;
  const encoding = typeof options === 'string' ? options : options?.encoding;
  const prefix = located.name ? `${located.name}/` : '';
  const children = new Map();
  for (const file of located.snapshot.entries.keys()) {
    if (!file.startsWith(prefix)) continue;
    const tail = file.slice(prefix.length), slash = tail.indexOf('/');
    const name = slash < 0 ? tail : tail.slice(0, slash);
    if (!name) continue;
    const childPath = prefix + name, child = located.snapshot.entries.get(childPath);
    const mode = slash < 0 && child ? modeBits(child.mode) : DIRECTORY_MODE;
    children.set(name, mode);
  }
  const names = [...children].sort(([left], [right]) => left.localeCompare(right));
  if (withFileTypes) return names.map(([name, mode]) => virtualDirent(name, mode, absolutePath(path), encoding));
  return names.map(([name]) => encoding === 'buffer' ? Buffer.from(name) : Buffer.from(name).toString(encoding || 'utf8'));
}
