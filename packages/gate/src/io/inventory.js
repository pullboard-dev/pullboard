/** Accepted cell inventories are warmed independently of submit and tied to trusted tooling [C7]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  spawn,
  execFileSync,
} from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  relative,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptedInventoryKey,
  readAcceptedInventory,
  warmAcceptedInventory,
} from '../../../codemap/index.js';
import {
  git,
  gitChildEnv,
  gitExecFileSync,
} from '../../../git/index.js';
import { machineHome } from '../../../resources/index.js';
import { withFileLock } from '../../../outbox/index.js';
import {
  importsIn,
  commonJsIn,
} from '../../../codemap/index.js';
import { withImportParseCache } from './imports.js';
import { foreignNodeOptions } from './test/isolation.js';

const TOOL_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

const TOOLING_PATHS = ['packages/codemap', 'packages/kernel', 'packages/git', 'packages/gate/src'];
const CODE_FILE = /\.[cm]?js$/u;

/** Hash name and content-hash pairs into the checker fingerprint, the one shape both sources produce. */
function foldFingerprint(files) { return createHash('sha256').update(JSON.stringify(files)).digest('hex'); }

/** Hash code bytes under stable repository-relative names, independent of a checkout's absolute path; the tooling root is a parameter so a fingerprint can describe any checkout. */
function checkerFingerprint(toolRoot = TOOL_ROOT) {
  const files = [];
  /** Capture the full conservative dependency cells so any parser, binding or report code change invalidates reuse. */
  function visit(path) {
    const entry = lstatSync(path);
    if (entry.isDirectory()) { for (const name of readdirSync(path).sort()) visit(join(path, name)); return; }
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('accepted cells tooling contains a nonregular path');
    if (CODE_FILE.test(path)) files.push([relative(toolRoot, path).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(path)).digest('hex')]);
  }
  for (const path of TOOLING_PATHS) visit(join(toolRoot, path));
  return foldFingerprint(files);
}

/**
 * The checker fingerprint of a commit's own tooling, read from its Git blobs and equal to what that commit's files hash to
 * on disk. Why: the identity of an accepted inventory must be a function of the pinned commit, not of whichever seat's
 * tooling snapshot happened to nudge or produce it.
 */
export function pinnedCheckerFingerprint(root, commit) {
  if (!HASH.test(commit ?? '')) throw new TypeError('accepted cells inventory needs an exact commit');
  const memo = `${root}\0${commit}`;
  if (PINNED_CHECKERS.has(memo)) return PINNED_CHECKERS.get(memo);
  const fingerprint = pinnedCheckerFingerprintFromGit(root, commit);
  if (PINNED_CHECKERS.size >= 64) PINNED_CHECKERS.delete(PINNED_CHECKERS.keys().next().value);
  PINNED_CHECKERS.set(memo, fingerprint);
  return fingerprint;
}

/** Pinned checker fingerprints by repository and commit; a commit's blobs never change, so a hit is always exact. */
const PINNED_CHECKERS = new Map();

/** Fold a commit's tooling blobs from Git into the checker fingerprint, in the same order a disk walk visits them. */
function pinnedCheckerFingerprintFromGit(root, commit) {
  const env = gitChildEnv(root);
  const listing = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...TOOLING_PATHS], { env }).split('\0').filter(Boolean);
  const rows = [];
  for (const row of listing) {
    const [meta, path] = [row.slice(0, row.indexOf('\t')), row.slice(row.indexOf('\t') + 1)];
    const [mode, , sha] = meta.split(' ');
    if (mode !== '100644' && mode !== '100755') throw new Error('accepted cells tooling contains a nonregular path');
    if (CODE_FILE.test(path)) rows.push({ path, sha });
  }
  const group = row => TOOLING_PATHS.findIndex(path => row.path.startsWith(`${path}/`));
  rows.sort((left, right) => {
    if (group(left) !== group(right)) return group(left) - group(right);
    const a = left.path.split('/'), b = right.path.split('/');
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    return a.length - b.length;
  });
  const out = rows.length ? gitExecFileSync(['-C', root, 'cat-file', '--batch'], { input: rows.map(row => `${row.sha}\n`).join(''), env, maxBuffer: 1 << 30 }) : Buffer.alloc(0);
  const files = [];
  let offset = 0;
  for (const row of rows) {
    const end = out.indexOf(10, offset), [, type, size] = out.subarray(offset, end).toString('utf8').split(' ');
    if (type !== 'blob') throw new Error('accepted cells tooling blob is unavailable');
    const start = end + 1, length = Number(size);
    files.push([row.path, createHash('sha256').update(out.subarray(start, start + length)).digest('hex')]);
    offset = start + length + 1;
  }
  return foldFingerprint(files);
}

/** Only known owned preloads may share canonical parser observations across machines. */
function preloadFingerprint() {
  if (foreignNodeOptions(process.env.NODE_OPTIONS)) throw new Error('foreign Node preload prevents accepted cells inventory reuse');
  return createHash('sha256').update('pullboard-known-owned-preloads-v1').digest('hex');
}

/**
 * Identify exact accepted source and trusted analyzer without building an inventory. By default the analyzer is the running
 * tooling (what a reader executes); `pinned` names the commit's own tooling, which is what a producer must record.
 */
export function acceptedCellsIdentity(root, commit, { pinned = false } = {}) {
  if (!HASH.test(commit ?? '')) throw new TypeError('accepted cells inventory needs an exact commit');
  const tree = git(root, ['rev-parse', `${commit}^{tree}`], { env: gitChildEnv(root) }).trim();
  if (!HASH.test(tree)) throw new Error('accepted cells inventory tree is unavailable');
  return { directory: join(machineHome(), 'cells-cache', 'accepted'), tree, checker: pinned ? pinnedCheckerFingerprint(root, commit) : checkerFingerprint(), preloads: preloadFingerprint() };
}

/** True when the running tooling is byte-identical to the pinned commit's own, so a producer here records the pinned checker. */
export function toolingIsPinned(root, commit) { return checkerFingerprint() === pinnedCheckerFingerprint(root, commit); }

/**
 * Read only a complete matching artifact; missing or invalid evidence never runs analysis.
 * Why the pinned identity: the accepted inventory of a commit is produced only by that commit's own tooling, so its
 * identity is a function of the commit. A reader running other tooling (a hand-off worker in a candidate that changes
 * the checker's files) used to look under its own checker key, found nothing the producer had published, and every
 * gate on that candidate ended CELLS_INVENTORY_PENDING (#3439, 7 Nov). The trusted checker that consumes the artifact
 * still compares the descriptor with its own identity before using it.
 */
export function readAcceptedCells(root, commit) {
  try {
    const identity = acceptedCellsIdentity(root, commit, { pinned: true });
    const found = readAcceptedInventory(identity);
    if (!found.available && found.cause !== 'missing-artifact') {
      try { rmSync(join(identity.directory, `${acceptedInventoryKey(identity)}.ready.json`), { force: true }); } catch { /* Next nudge may retry. */ }
    }
    return found;
  } catch (error) { return { available: false, cause: 'identity-unavailable', message: error.message }; }
}

/** Save only completed metadata atomically; a failed producer leaves an actionable diagnostic. */
function save(file, data) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}

const LOCKED = /\b(?:database is locked|SQLITE_BUSY)\b/iu;
/** Reruns of one inventory production after a lock stop; a lock that outlasts them is an infrastructure stop, never a red [C7]. */
export const INVENTORY_LOCK_RETRIES = 3;

/**
 * Run `work`, and when it fails only because a SQLite database was locked, run it again up to `retries` more times.
 * Why: the producer's file lock waits 60 s, and on 15 Nov a runner's inventory ended 'database is locked' because
 * another gate held the lock for longer; the lock always frees, so the gate waits and runs the production again (#8415).
 * Any other failure, and the last lock failure, goes up unchanged so a real red is never masked.
 *
 * @template T
 * @param {() => Promise<T>} work
 * @param {{ retries?: number, pause?: (ms: number) => Promise<unknown>, pauseMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function retryLockedProduction(work, { retries = INVENTORY_LOCK_RETRIES, pause = ms => new Promise(done => setTimeout(done, ms)), pauseMs = 5_000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await work(); }
    catch (error) {
      if (attempt >= retries || !LOCKED.test(String(error?.message ?? error))) throw error;
      await pause(pauseMs * 2 ** attempt);
    }
  }
}

/**
 * Build a verified accepted tree off-path, reusing the nearest compatible completed ancestor where possible.
 * `trunk` is the accepted commit or ref the produced commit must descend into: main's branch on the coordinator, the
 * controller's pinned main on a runner, whose checkout's main branch is the candidate's merged trunk (#2535).
 *
 * @param {string} root - Absolute repository root.
 * @param {string} commit - The accepted commit whose inventory is produced.
 * @param {{ withCheckout: Function, withLock: Function, trunk?: string, lockRetry?: object }} ports
 */
export async function warmAcceptedCells(root, commit, { withCheckout, withLock, trunk = 'refs/heads/main', lockRetry = {} } = {}) {
  if (typeof withCheckout !== 'function' || typeof withLock !== 'function') throw new TypeError('accepted cells warm needs checkout and lock ports');
  git(root, ['merge-base', '--is-ancestor', commit, trunk], { env: gitChildEnv(root) });
  if (!git(root, ['ls-tree', '--name-only', commit, '--', 'packages/codemap/data/plan/cells.json'], { env: gitChildEnv(root) })) return { available: false, cause: 'no-cells-plan' };
  // The pinned commit's checker is recorded here: produceAcceptedCells warms in-process only when the running tooling is
  // the pinned one and otherwise re-runs the app's landing audit from the pinned checkout, so readers find it by the commit alone.
  const identity = acceptedCellsIdentity(root, commit, { pinned: true }), key = acceptedInventoryKey(identity);
  let prior;
  const ancestors = git(root, ['log', '--first-parent', '--max-count=201', '--format=%H %T', commit], { env: gitChildEnv(root) }).split('\n').slice(1);
  for (const row of ancestors) {
    const [candidate, tree] = row.split(' ');
    if (!HASH.test(candidate ?? '') || !HASH.test(tree ?? '')) continue;
    const artifact = readAcceptedInventory({ ...identity, tree });
    if (artifact.available) { prior = { commit: candidate, artifact }; break; }
  }
  let mode = 'cache';
  const originalPreloads = identity.preloads;
  const result = await retryLockedProduction(() => withCheckout(root, commit, checkout => warmAcceptedInventory({ ...identity, root: checkout, commit, withLock,
    parsers: { importsIn, commonJsIn }, withImportParseCache, eligible: () => preloadFingerprint() === originalPreloads,
    prior, onMode: value => { mode = value; } })), lockRetry);
  if (!result?.available) throw new Error(result?.unavailable ?? 'accepted cells inventory checkout failed');
  const file = join(identity.directory, `${key}.inventory.gz`), stat = lstatSync(file);
  save(join(identity.directory, `${key}.ready.json`), { version: 1, tree: identity.tree, checker: identity.checker, preloads: identity.preloads, key, bytes: stat.size, modified: stat.mtimeMs, digest: result.descriptor.digest, mode, ancestor: prior?.commit ?? null });
  try { rmSync(join(identity.directory, `${key}.failure.json`), { force: true }); } catch { /* A stale failure is advisory. */ }
  return { ...result, mode };
}

/** Identify a live process conservatively, treating unknown start identity as live. */
function ownerLive(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) return true;
  try { process.kill(owner.pid, 0); } catch (error) { return error.code !== 'ESRCH'; }
  try {
    const started = execFileSync('/bin/ps', ['-p', String(owner.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim();
    return !started || !owner.started || started === owner.started;
  } catch { return true; }
}

/** Name a process incarnation where the OS supplies it; unavailable identity never permits stealing. */
function started(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim() || null; }
  catch { return null; }
}

/** Start at most one independent producer for a pinned main ancestor without waiting for its census. */
export async function nudgeAcceptedCells(root, workerUrl, commit) {
  if (!(workerUrl instanceof URL) || workerUrl.protocol !== 'file:' || !HASH.test(commit ?? '')) throw new TypeError('accepted cells nudge needs a worker URL and pinned commit');
  git(root, ['merge-base', '--is-ancestor', commit, 'refs/heads/main'], { env: gitChildEnv(root) });
  if (!git(root, ['ls-tree', '--name-only', commit, '--', 'packages/codemap/data/plan/cells.json'], { env: gitChildEnv(root) })) return null;
  const identity = acceptedCellsIdentity(root, commit, { pinned: true }), key = acceptedInventoryKey(identity), directory = identity.directory;
  return withFileLock(join(directory, `${key}.owner-lock.sqlite`), async () => {
    const artifact = join(directory, `${key}.inventory.gz`), readyFile = join(directory, `${key}.ready.json`), ownerFile = join(directory, `${key}.owner.json`);
    try {
      const ready = JSON.parse(readFileSync(readyFile, 'utf8')), stat = lstatSync(artifact);
      if (ready.version === 1 && ready.key === key && ready.tree === identity.tree
        && ready.checker === identity.checker && ready.preloads === identity.preloads && stat.isFile() && !stat.isSymbolicLink()
        && ready.bytes === stat.size && ready.modified === stat.mtimeMs) return null;
    } catch { /* Missing or incomplete publication needs a producer. */ }
    try { if (ownerLive(JSON.parse(readFileSync(ownerFile, 'utf8')))) return null; }
    catch (error) { if (error.code !== 'ENOENT') return null; /* Unknown ownership cannot be stolen. */ }
    const env = gitChildEnv(root);
    for (const name of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_CHECKOUT_SESSION_TOKEN']) delete env[name];
    const token = randomUUID();
    const child = spawn(process.execPath, [fileURLToPath(workerUrl), root, token, '--cells-only', commit], { cwd: root, env, detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    save(ownerFile, { version: 1, pid: child.pid, started: started(child.pid), token, tree: identity.tree });
    child.unref();
    return child;
  });
}

/** Retain a bounded diagnostic when a detached producer cannot finish. */
export function recordAcceptedCellsFailure(root, commit, error) {
  let identity, key;
  try { identity = acceptedCellsIdentity(root, commit, { pinned: true }); key = acceptedInventoryKey(identity); }
  catch { identity = { directory: join(machineHome(), 'cells-cache', 'accepted'), tree: null }; key = HASH.test(commit ?? '') ? commit : 'unknown'; }
  save(join(identity.directory, `${key}.failure.json`), { version: 1, tree: identity.tree, at: new Date().toISOString(), message: String(error?.message ?? error).slice(0, 2048) });
}

/**
 * Read the producer's owner record for a commit: 'live', 'dead' (a record whose process is gone), or 'none'.
 * Why the pinned key: nudgeAcceptedCells writes the record under the pinned identity, so a worker whose own tooling
 * differs from main's still finds the producer that is working on that commit.
 */
function ownerState(root, commit) {
  let text;
  try {
    const identity = acceptedCellsIdentity(root, commit, { pinned: true });
    text = readFileSync(join(identity.directory, `${acceptedInventoryKey(identity)}.owner.json`), 'utf8');
  } catch { return 'none'; }
  try { return ownerLive(JSON.parse(text)) ? 'live' : 'dead'; } catch { return 'dead'; }
}

/** Resolve after `ms`; the default sleep, replaced by a fixture's own clock. */
function defaultSleep(ms) {
  return new Promise(done => setTimeout(done, ms));
}

/** The retryable stop a wait ends with, carrying its commit so the caller can name it. */
function stillPending(commit, message) {
  return Object.assign(new Error(`accepted cells inventory for ${commit.slice(0, 12)} ${message}`),
    { name: 'CellsInventoryInfrastructureError', code: 'CELLS_INVENTORY_PENDING', retryable: true, commit });
}

/**
 * Wait for a commit's accepted inventory to be published by its independent producer, and return the artifact with
 * `waited`, the number of polls it took. Polls readAcceptedCells every intervalMs while the producer's owner record is
 * live, calling `beat` after each poll so the job log shows the wait is alive. A producer that is dead or absent is
 * nudged once more; if it is still not running after that, or dies again, the wait ends at once with a clear
 * CELLS_INVENTORY_PENDING stop instead of sleeping out the deadline. limitMs bounds the whole wait.
 * `workerUrl` is the app's landing audit entry, passed in because no package names an app; without it no re-nudge starts.
 * Why: a landing starts a 2 to 5 minute producer, longer than the quick infrastructure retries, so the gate waits on
 * the producer instead of spending those retries (#3316).
 *
 * @param {string} root
 * @param {string} commit
 * @param {{ now?: () => number, sleep?: (ms: number) => Promise<void>, limitMs?: number, intervalMs?: number, workerUrl?: URL, read?: Function, nudge?: Function, owner?: Function, beat?: (line: string) => void }} [options]
 * @returns {Promise<{ available: true, waited: number }>}
 */
export async function waitForAcceptedCells(root, commit, { now = Date.now, sleep = defaultSleep, limitMs = 15 * 60_000, intervalMs = 15_000,
  workerUrl, read = readAcceptedCells, nudge = nudgeAcceptedCells, owner = ownerState, beat = () => {} } = {}) {
  const started = now(), deadline = started + limitMs;
  let renudged = false;
  for (let waited = 0; ; waited += 1) {
    const found = read(root, commit);
    if (found.available) return { ...found, waited };
    if (owner(root, commit) !== 'live') {
      if (renudged) throw stillPending(commit, `has no live producer after one re-nudge (${found.cause}); requeue after a producer runs for it`);
      renudged = true;
      try { await nudge(root, workerUrl, commit); } catch { /* The owner check below names what is still missing. */ }
      if (owner(root, commit) !== 'live') throw stillPending(commit, `has no live producer: it died or never started, and one re-nudge did not start one (${found.cause}); requeue after a producer runs for it`);
    }
    if (now() + intervalMs > deadline) throw stillPending(commit, `is still warming after ${Math.round(limitMs / 1000)} s (${found.cause}); requeue after the independent producer finishes`);
    await sleep(intervalMs);
    beat(`accepted cells inventory for ${commit.slice(0, 12)} is still warming (${found.cause}); waited ${Math.round((now() - started) / 1000)} s of ${Math.round(limitMs / 1000)} s on its live producer`);
  }
}
