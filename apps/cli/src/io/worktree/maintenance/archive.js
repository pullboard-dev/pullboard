/** Preserve exact local work before maintenance may reset or remove a checkout [B3,C7]. */
import { gitSpawnSync } from '../../../../../../packages/git/index.js';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { closeSync } from 'node:fs';
import { fstatSync } from 'node:fs';
import { fsyncSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readlinkSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { statfsSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { cleanGitEnvironment } from '../../../../../../packages/git/index.js';

const MAX_OBSERVATION_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW;
const GIB = 1024 ** 3;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** A failed observation supplies neither a recoverable archive nor permission to erase source. */
export function maintenanceGit(root, args, { binary = false } = {}) {
  const result = gitSpawnSync(args, { cwd: root, env: { ...cleanGitEnvironment(), GIT_OPTIONAL_LOCKS: '0' },
    encoding: binary ? undefined : 'utf8', timeout: 10_000, maxBuffer: MAX_OBSERVATION_BYTES });
  if (result.status !== 0 || result.error || result.signal) throw new Error('maintenance Git observation failed: ' + args[0]);
  return result.stdout;
}

/** Git paths must remain literal relative UTF-8 paths; unknown spellings keep the checkout. */
function paths(bytes) {
  if (bytes.length && bytes.at(-1) !== 0) throw new Error('incomplete maintenance path list');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('maintenance cannot archive a non-UTF-8 path');
  return text.split('\0').filter(Boolean).map(path => {
    if (isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git'))
      throw new Error('maintenance path is outside the checkout');
    return path;
  });
}

/** Compare inode and observation metadata, not just length or a path that can be reused. */
function sameFile(a, b) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
}

/** Refuse symlink parents and remember their identities for a post-read check. */
function localPath(root, path) {
  const target = resolve(root, path), part = relative(root, target);
  if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('invalid archive path');
  const parents = [];
  let parent = root;
  for (const name of ['', ...part.split(sep).slice(0, -1)]) {
    parent = name ? join(parent, name) : parent;
    const state = lstatSync(parent);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('maintenance archive parent is not a directory');
    parents.push({ path: parent, dev: state.dev, ino: state.ino });
  }
  return { target, check() {
    for (const entry of parents) {
      const current = lstatSync(entry.path);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino)
        throw new Error('maintenance archive parent changed');
    }
  } };
}

/** Hash or copy a regular file with a fixed one-MiB buffer, never following its final symlink. */
function regularFile(path, { destination, privateFile = false } = {}) {
  if (!Number.isInteger(NOFOLLOW)) throw new Error('maintenance needs no-follow file observation');
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size < 0
    || privateFile && (before.mode & 0o077)) throw new Error('invalid maintenance archive file');
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  let output;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error('archive file identity changed');
    if (destination) output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES), hash = createHash('sha256');
    let size = 0, count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      size += count;
      if (!Number.isSafeInteger(size) || size > opened.size) throw new Error('archive file grew while being read');
      hash.update(buffer.subarray(0, count));
      if (output !== undefined) for (let offset = 0; offset < count;) {
        const written = writeSync(output, buffer, offset, count - offset);
        if (written < 1) throw new Error('archive copy made no progress');
        offset += written;
      }
    }
    if (size !== opened.size || !sameFile(opened, fstatSync(fd)) || !sameFile(opened, lstatSync(path)))
      throw new Error('archive file changed while being read');
    if (output !== undefined) fsyncSync(output);
    return { type: 'file', mode: opened.mode & 0o7777, sha256: hash.digest('hex'), size };
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(fd);
  }
}

/** Observe a source leaf without retaining any regular-file content in the snapshot. */
function localFile(root, path, destination) {
  const observed = localPath(root, path), before = lstatSync(observed.target);
  let metadata;
  if (before.isSymbolicLink()) {
    const bytes = readlinkSync(observed.target, { encoding: 'buffer' });
    if (!sameFile(before, lstatSync(observed.target))) throw new Error('archive symlink changed');
    if (destination) privateWrite(destination, bytes);
    metadata = { type: 'symlink', mode: before.mode & 0o7777, targetBase64: bytes.toString('base64'), sha256: digest(bytes), size: bytes.length };
  } else metadata = regularFile(observed.target, { destination });
  observed.check();
  return { path, ...metadata };
}

/** Write a complete private artifact before publishing a complete manifest. */
function privateWrite(file, bytes) {
  if (!Number.isInteger(NOFOLLOW)) throw new Error('maintenance needs no-follow file observation');
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    for (let offset = 0; offset < bytes.length;) {
      const count = writeSync(fd, bytes, offset, Math.min(CHUNK_BYTES, bytes.length - offset));
      if (count < 1) throw new Error('archive write made no progress');
      offset += count;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** Preserve only a literal linked Git directory, never the primary or repository-wide metadata. */
function metadataSnapshot(root, common) {
  const gitDir = maintenanceGit(root, ['rev-parse', '--path-format=absolute', '--git-dir']).replace(/\n$/u, '');
  const parent = join(common, 'worktrees'), name = relative(parent, gitDir);
  if (!name || name === '..' || name.includes(sep) || isAbsolute(name) || resolve(parent, name) !== gitDir)
    throw new Error('maintenance metadata needs a linked worktree Git directory');
  for (const path of [parent, gitDir]) {
    const state = lstatSync(path);
    if (!state.isDirectory() || state.isSymbolicLink() || realpathSync(path) !== path)
      throw new Error('maintenance metadata directory identity changed');
  }
  const state = lstatSync(gitDir), files = [], directories = [];
  const visit = (path = '') => {
    const directory = join(gitDir, path), before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('maintenance metadata parent is not a directory');
    directories.push({ path, mode: before.mode & 0o7777, dev: before.dev, ino: before.ino });
    const entries = readdirSync(directory, { encoding: 'buffer' }).map(bytes => {
      const name = bytes.toString('utf8');
      if (!Buffer.from(name).equals(bytes) || !name || name === '.' || name === '..' || name.endsWith('.lock'))
        throw new Error('maintenance metadata has an unsupported path or lock');
      return name;
    }).sort();
    for (const name of entries) {
      const child = path ? path + '/' + name : name, current = lstatSync(join(gitDir, child));
      if (current.isDirectory() && !current.isSymbolicLink()) visit(child);
      else files.push(localFile(gitDir, child));
    }
    if (!sameFile(before, lstatSync(directory))) throw new Error('maintenance metadata directory changed');
  };
  visit();
  if (!sameFile(state, lstatSync(gitDir))) throw new Error('maintenance metadata changed during observation');
  const identity = { gitDir, directories, files };
  return { ...identity, signature: digest(JSON.stringify(identity)) };
}

/** Observe staged and unstaged changes separately, optionally retaining the linked Git directory too. */
export function maintenanceSnapshot(root, { includeMetadata = false } = {}) {
  if (typeof includeMetadata !== 'boolean') throw new Error('maintenance metadata option must be a boolean');
  const state = lstatSync(root);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('maintenance root identity changed');
  const canonical = realpathSync(root);
  const head = maintenanceGit(root, ['rev-parse', '--verify', 'HEAD']).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) throw new Error('invalid maintenance HEAD');
  const common = realpathSync(maintenanceGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  if (maintenanceGit(root, ['ls-files', '--unmerged', '-z'], { binary: true }).length) throw new Error('maintenance cannot archive an unresolved index');
  const stagedBuffer = maintenanceGit(root, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv'], { binary: true });
  const unstagedBuffer = maintenanceGit(root, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv'], { binary: true });
  const untracked = paths(maintenanceGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], { binary: true }));
  const ignored = paths(maintenanceGit(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { binary: true }));
  const files = [...new Set([...untracked, ...ignored])].sort().map(path => localFile(canonical, path));
  const metadata = includeMetadata ? metadataSnapshot(root, common) : undefined;
  const identity = { head, common, rootIdentity: { root: canonical, dev: state.dev, ino: state.ino },
    staged: digest(stagedBuffer), unstaged: digest(unstagedBuffer), files, ...(metadata ? { metadata } : {}) };
  if (realpathSync(root) !== canonical || !sameFile(state, lstatSync(root))) throw new Error('maintenance root changed during observation');
  return { ...identity, stagedBuffer, unstagedBuffer, signature: digest(JSON.stringify(identity)),
    dirty: Boolean(stagedBuffer.length || unstagedBuffer.length || files.length) };
}

/**
 * The archive folder itself may be a symlink to another volume, but only to a directory this user owns with no group or other access [C7].
 * Its children are never followed: any deeper symlink still refuses.
 */
function privateArchiveBase(path) {
  const link = lstatSync(path);
  const state = link.isSymbolicLink() ? statSync(path) : link;
  const owner = typeof process.getuid === 'function' ? process.getuid() : state.uid;
  return state.isDirectory() && state.uid === owner && !(state.mode & 0o077);
}

/** Only real private directories in this repository may contain recovery artifacts. */
function archiveDirectory(common, id) {
  let directory = realpathSync(common);
  for (const name of ['pullboard', 'worktree-archives', id, 'blobs']) {
    directory = join(directory, name);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST' || name === id) throw error; }
    if (name === 'worktree-archives') {
      if (!privateArchiveBase(directory)) throw new Error('maintenance archive directory is not private');
      continue;
    }
    const state = lstatSync(directory);
    if (!state.isDirectory() || state.isSymbolicLink() || name !== 'pullboard' && (state.mode & 0o077))
      throw new Error('maintenance archive directory is not private');
  }
  return join(directory, '..');
}

/**
 * Free and total bytes on the volume that actually holds the archives; unknown space refuses the copy rather than guessing.
 * The archive directory may be a symlink to another volume, so measure its resolved target, or the nearest existing parent.
 */
export function archiveVolume(common, statfs = statfsSync) {
  let target = join(realpathSync(common), 'pullboard', 'worktree-archives');
  for (;;) {
    try { target = realpathSync(target); break; }
    catch (error) {
      const parent = resolve(target, '..');
      if (error.code !== 'ENOENT' || parent === target) throw error;
      target = parent;
    }
  }
  const state = statfs(target, { bigint: false });
  return { freeBytes: state.bavail * state.bsize, totalBytes: state.blocks * state.bsize };
}

/**
 * Refuse a copy that would leave less than the larger of 10 GB or 5% of the volume free [C7].
 * Bytes are counted once per distinct content, as the archive stores them, so the source stays untouched when it refuses.
 */
function requireArchiveSpace(root, common, snapshot, volume) {
  const seen = new Set();
  let needed = snapshot.stagedBuffer.length + snapshot.unstagedBuffer.length;
  for (const file of [...snapshot.files, ...(snapshot.metadata?.files ?? [])])
    if (!seen.has(file.sha256)) { seen.add(file.sha256); needed += file.size; }
  let space;
  try { space = volume(common); } catch { space = null; }
  if (!space || !Number.isFinite(space.freeBytes) || !Number.isFinite(space.totalBytes))
    throw new Error(`ARCHIVE_WOULD_FILL_DISK: ${root} needs ${needed} bytes and the free space on the archive volume is unknown; worktree kept`);
  const reserve = Math.max(10 * GIB, space.totalBytes * 0.05);
  if (space.freeBytes - needed < reserve)
    throw new Error(`ARCHIVE_WOULD_FILL_DISK: ${root} needs ${needed} bytes, ${space.freeBytes} bytes are free, and the archive volume must keep ${Math.ceil(reserve)} free; worktree kept`);
}

/**
 * Remove an archive an interrupted run began but never finished (no manifest), and only while its source still exists [C7].
 * An archive with a manifest, or whose source is gone, may be the only copy of that work and stays.
 */
export function removePartialArchives(common) {
  const base = join(realpathSync(common), 'pullboard', 'worktree-archives'), removed = [];
  let ids;
  try { ids = readdirSync(base); } catch { return removed; }
  for (const id of ids) {
    if (!/^[a-f0-9-]{36}$/u.test(id)) continue;
    const directory = join(base, id);
    try {
      const state = lstatSync(directory);
      if (!state.isDirectory() || state.isSymbolicLink() || existsSync(join(directory, 'manifest.json'))) continue;
      const pending = JSON.parse(readFileSync(join(directory, 'pending.json'), 'utf8'));
      if (pending.id !== id || typeof pending.root !== 'string' || !isAbsolute(pending.root) || !existsSync(pending.root)) continue;
      try { maintenanceGit(pending.root, ['update-ref', '-d', 'refs/pullboard/worktree-archives/' + id]); } catch { /* no ref was made */ }
      rmSync(directory, { recursive: true, force: true });
      removed.push(id);
    } catch { /* an unreadable partial stays for a person to inspect */ }
  }
  return removed;
}

/** Save complete private bytes and a durable HEAD ref before returning any reset permission. */
export function archiveMaintenanceWorktree(root, common, { now = new Date().toISOString(), includeMetadata = false, volume = archiveVolume } = {}) {
  const before = maintenanceSnapshot(root, { includeMetadata });
  if (before.common !== realpathSync(common)) throw new Error('maintenance repository changed');
  requireArchiveSpace(root, common, before, volume);
  const id = randomUUID(), directory = archiveDirectory(common, id);
  privateWrite(join(directory, 'pending.json'), Buffer.from(JSON.stringify({ id, root }) + '\n'));
  privateWrite(join(directory, 'staged.patch'), before.stagedBuffer);
  privateWrite(join(directory, 'unstaged.patch'), before.unstagedBuffer);
  const copied = new Set();
  for (const { source, file } of [
    ...before.files.map(file => ({ source: before.rootIdentity.root, file })),
    ...(before.metadata?.files ?? []).map(file => ({ source: before.metadata.gitDir, file })),
  ]) {
    const blob = join(directory, 'blobs', file.sha256);
    if (copied.has(file.sha256)) {
      const current = localFile(source, file.path);
      if (JSON.stringify(current) !== JSON.stringify(file)) throw new Error('worktree changed during archive; source retained');
    } else {
      const current = localFile(source, file.path, blob);
      if (JSON.stringify(current) !== JSON.stringify(file)) throw new Error('worktree changed during archive; source retained');
      copied.add(file.sha256);
    }
  }
  const ref = 'refs/pullboard/worktree-archives/' + id;
  maintenanceGit(root, ['update-ref', ref, before.head, '0'.repeat(before.head.length)]);
  if (before.signature !== maintenanceSnapshot(root, { includeMetadata }).signature) throw new Error('worktree changed during archive; source retained');
  const manifest = { version: 1, id, root, common: before.common, head: before.head, ref, at: now,
    signature: before.signature, rootIdentity: before.rootIdentity, staged: before.staged, unstaged: before.unstaged, files: before.files,
    ...(before.metadata ? { metadata: before.metadata } : {}),
    bytes: before.stagedBuffer.length + before.unstagedBuffer.length
      + [...before.files, ...(before.metadata?.files ?? [])].reduce((sum, file) => sum + file.size, 0) };
  privateWrite(join(directory, 'manifest.tmp'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  renameSync(join(directory, 'manifest.tmp'), join(directory, 'manifest.json'));
  unlinkSync(join(directory, 'pending.json'));
  const archive = { directory, manifest };
  if (!maintenanceArchiveMatches(root, archive)) throw new Error('maintenance archive did not verify; source retained');
  return archive;
}

/** Recheck archive integrity and current source immediately before a separately authorized reset or removal. */
export function maintenanceArchiveMatches(root, archive) {
  try {
    const { directory, manifest } = archive;
    if (directory !== resolve(manifest.common, 'pullboard', 'worktree-archives', manifest.id)
      || !/^[a-f0-9-]{36}$/u.test(manifest.id) || manifest.root !== root || manifest.version !== 1) return false;
    const base = join(manifest.common, 'pullboard', 'worktree-archives');
    if (!privateArchiveBase(base)) return false;
    for (const path of [directory, join(directory, 'blobs')]) {
      const state = lstatSync(path);
      if (!state.isDirectory() || state.isSymbolicLink() || state.mode & 0o077) return false;
    }
    const observed = localPath(realpathSync(base), join(manifest.id, 'manifest.json'));
    const info = regularFile(observed.target, { privateFile: true });
    if (info.size > MAX_OBSERVATION_BYTES) return false;
    const stored = manifest;
    observed.check();
    if (digest(JSON.stringify(stored, null, 2) + '\n') !== info.sha256) return false;
    const verify = (path, expected, size) => {
      const location = localPath(directory, path), result = regularFile(location.target, { privateFile: true });
      location.check();
      return result.sha256 === expected && (size === undefined || result.size === size);
    };
    if (!verify('staged.patch', stored.staged) || !verify('unstaged.patch', stored.unstaged)) return false;
    if ([...stored.files, ...(stored.metadata?.files ?? [])].some(file => !/^[a-f0-9]{64}$/u.test(file.sha256)
      || !verify('blobs/' + file.sha256, file.sha256, file.size))) return false;
    if (maintenanceGit(root, ['rev-parse', '--verify', stored.ref]).trim() !== stored.head) return false;
    return maintenanceSnapshot(root, { includeMetadata: Boolean(stored.metadata) }).signature === stored.signature;
  } catch { return false; /* Unknown observations never authorize cleanup. */ }
}
