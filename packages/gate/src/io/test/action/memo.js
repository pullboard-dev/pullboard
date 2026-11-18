/** Immutable, per-file key memos: an unchanged tree reads only the requested key records [C7]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  openSync,
  closeSync,
  linkSync,
} from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { gateMachineHome } from '../../preload.js';
import { storeName } from '../../store-names.js';

/** Name a selector without making its path part of a cache filesystem path. */
function name(file) { return createHash('sha256').update(file).digest('hex'); }

/** Detect a damaged memo record even when its altered key is still syntactically a hash. */
function checksum(identity, file, value) {
  return createHash('sha256').update(JSON.stringify({ identity, file, value })).digest('hex');
}

/** Publish one complete JSON value; another planner never sees a partially written record. */
function publish(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

const MEMO_MAX_AGE_MS = 2 * 3_600_000;
const PRUNE_EVERY_MS = 600_000;

/** The one directory every repository and checkout on this machine shares; tests isolate it with their machine home. */
function pruneMarkerDirectory() {
  const override = process.env.PULLBOARD_MACHINE_HOME, accountHome = process.env.PULLBOARD_ACCOUNT_HOME;
  return join(gateMachineHome({ override, accountHome, osHome: override || accountHome ? undefined : userInfo().homedir }), 'key-memo-prune');
}

/**
 * Claim this machine's prune turn, or report that another caller holds it.
 * Why: the marker is one file named `prune-<last prune time>` in a machine-wide folder. A claim renames it to
 * `prune-<now>`; a rename needs its source, so when callers race for the same stale marker the filesystem lets exactly
 * one rename succeed and the rest see ENOENT. There is no check-then-write, no lock file and no remove-then-create.
 *
 * @param {string} directory
 * @param {number} now
 * @returns {boolean} true for the single winner.
 */
function claimPruneTurn(directory, now) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  /** The newest recorded prune time, or null when no marker exists yet. */
  const latest = () => {
    const times = readdirSync(directory).map(entry => /^prune-(\d+)$/u.exec(entry)).filter(Boolean).map(match => Number(match[1]));
    return times.length ? Math.max(...times) : null;
  };
  let last = latest();
  if (last === null) {
    // First use on this machine: the exclusive create decides one creator; a loser just reads the winner's marker.
    try { closeSync(openSync(join(directory, 'prune-0'), 'wx')); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    last = latest();
  }
  if (last === null || now - last < PRUNE_EVERY_MS) return false;
  try { renameSync(join(directory, `prune-${last}`), join(directory, `prune-${now}`)); } catch { return false; }
  return true;
}

/**
 * Remove key memo folders not read or written for 2 hours, at most once per 10 minutes per machine, the way
 * pruneRuns ages out run folders. A pruned memo simply rebuilds on its next use. Why: one ~4 MB memo per tested
 * tree filled the coordinator disk.
 *
 * @param {string} store
 * @param {number} [now]
 * @returns {boolean} whether this call won the machine's prune turn and pruned.
 */
export function pruneKeyMemos(store, now = Date.now()) {
  try { if (!claimPruneTurn(pruneMarkerDirectory(), now)) return false; } catch { return false; }
  removeOldMemos(join(store, 'keys'), now);
  return true;
}

/**
 * Remove every key memo folder under `keys` older than the memo age limit.
 *
 * @param {string} keys
 * @param {number} now
 */
function removeOldMemos(keys, now) {
  let names = [];
  try { names = readdirSync(keys); } catch { return; }
  for (const folder of names) {
    try { if (now - statSync(join(keys, folder)).mtimeMs > MEMO_MAX_AGE_MS) rmSync(join(keys, folder), { recursive: true, force: true }); }
    catch { /* A folder another run removed first needs nothing more. */ }
  }
}

/**
 * Read the requested records of an immutable key plan, or compute it once on a cold tree.
 * The existing conservative graph builder still owns cold-tree cost; this memo does not claim
 * incremental graph construction. A missing, corrupt or mismatched record always rebuilds.
 *
 * @param {string} store
 * @param {string} identity committed tree, key algorithm, material options and execution context
 * @param {string[] | undefined} files undefined requests every known test, otherwise only these files
 * @param {() => Promise<Map<string, object>>} build
 * @param {{ prune?: boolean }} [options] - false leaves the memo age sweep to a caller off the gate's path.
 * @returns {Promise<Map<string, object>>}
 */
export async function memoizedActionKeys(store, identity, files, build, { prune = true } = {}) {
  const directory = join(store, 'keys', identity);
  if (prune) pruneKeyMemos(store);
  let keys = readKeyMemo(directory, identity, files);
  if (keys) return keys;
  // One build per tree: the shards and the analysis trip of one gate ask for the same cold tree at once, and each
  // built the whole graph, 16 s apiece on the controller (11 Nov) [C7,#5728]. A waiter reads the builder's memo.
  const release = await takeKeyBuild(`${directory}.lock`, () => statSync(join(directory, 'index.json'), { throwIfNoEntry: false }) !== undefined);
  try {
    keys = readKeyMemo(directory, identity, files);
    if (keys) return keys;
    return await buildKeyMemo(directory, identity, files, build);
  } finally { release?.(); }
}

/** How long a key build lock may stand before a waiter treats its holder as stuck and builds itself. */
const BUILD_LOCK_STALE_MS = 10 * 60_000;

/** Whether a build lock's holder has exited or held it past any real build. */
function staleBuildLock(lock) {
  try {
    const { pid, at } = JSON.parse(readFileSync(lock, 'utf8'));
    if (!(Date.now() - at < BUILD_LOCK_STALE_MS)) return true;
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  } catch (error) { return error.code !== 'ENOENT'; }
}

/**
 * Become the one caller that builds this tree's keys, or wait until that caller's memo is published. Returns a release
 * function for the builder, or null once `settled`; a lock that cannot be written only costs the single flight.
 */
async function takeKeyBuild(lock, settled) {
  for (;;) {
    if (settled()) return null;
    const pending = `${lock}.${process.pid}.${randomUUID()}`;
    try {
      mkdirSync(join(lock, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(pending, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
      // A hard link either creates the complete lock or fails because another caller holds it.
      linkSync(pending, lock);
      return () => rmSync(lock, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') return () => {};
    } finally { rmSync(pending, { force: true }); }
    if (staleBuildLock(lock)) rmSync(lock, { force: true });
    else await delay(100);
  }
}

/** The requested records of a published key memo, or null when it is cold, damaged or lacks one of them. */
function readKeyMemo(directory, identity, files) {
  try {
    const index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8'));
    if (index.identity !== identity) throw new Error('invalid key memo');
    // Explicit selections do not even parse the all-tests catalog.
    const selected = files ?? JSON.parse(readFileSync(join(directory, 'files.json'), 'utf8'));
    if (!Array.isArray(selected) || selected.some(file => typeof file !== 'string')) throw new Error('invalid key catalog');
    const keys = new Map();
    for (const file of selected) {
      const record = JSON.parse(readFileSync(join(directory, storeName(name(file))), 'utf8'));
      if (record.identity !== identity || record.file !== file
        || record.checksum !== checksum(identity, file, record.value)
        || !(record.value?.key === null || /^[0-9a-f]{64}$/u.test(record.value?.key)) || typeof record.value.reason !== 'string') throw new Error('invalid key record');
      keys.set(file, record.value);
    }
    try { const now = new Date(); utimesSync(directory, now, now); } catch { /* Age is best effort. */ }
    return keys;
  } catch { return null; /* A cold or unverifiable memo uses the ordinary conservative graph builder. */ }
}

/**
 * Build a tree's keys with the conservative graph builder and publish its memo; storage is best effort. An explicit
 * selection builds and publishes only its own records, so the all-tests catalog (files.json) is written by a full build
 * alone and a later caller missing a record builds just that one [C7,#6672].
 */
async function buildKeyMemo(directory, identity, files, build) {
  const keys = await build();
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [file, value] of keys) publish(join(directory, storeName(name(file))), { identity, file, value, checksum: checksum(identity, file, value) });
    if (!files) publish(join(directory, 'files.json'), [...keys.keys()]);
    publish(join(directory, 'index.json'), { identity });
  } catch { /* Storage is an optimization; the freshly computed keys remain usable. */ }
  return files ? new Map(files.filter(file => keys.has(file)).map(file => [file, keys.get(file)])) : keys;
}
