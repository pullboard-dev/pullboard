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
} from '../../../git/index.js';
import { machineHome } from '../../../resources/index.js';
import { withFileLock } from '../../../outbox/index.js';
import {
  importsIn,
  commonJsIn,
} from './module-imports.js';
import { withImportParseCache } from './module-import-cache.js';
import { foreignNodeOptions } from './test-isolation.js';

const TOOL_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Hash code bytes under stable repository-relative names, independent of a checkout's absolute path. */
function checkerFingerprint() {
  const files = [];
  /** Capture the full conservative dependency cells so any parser, binding or report code change invalidates reuse. */
  function visit(path) {
    const entry = lstatSync(path);
    if (entry.isDirectory()) { for (const name of readdirSync(path).sort()) visit(join(path, name)); return; }
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('accepted cells tooling contains a nonregular path');
    if (/\.[cm]?js$/u.test(path)) files.push([relative(TOOL_ROOT, path).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(path)).digest('hex')]);
  }
  for (const path of ['packages/codemap', 'packages/kernel', 'packages/git', 'packages/gate/src']) visit(join(TOOL_ROOT, path));
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

/** Only known owned preloads may share canonical parser observations across machines. */
function preloadFingerprint() {
  if (foreignNodeOptions(process.env.NODE_OPTIONS)) throw new Error('foreign Node preload prevents accepted cells inventory reuse');
  return createHash('sha256').update('pullboard-known-owned-preloads-v1').digest('hex');
}

/** Identify exact accepted source and current trusted analyzer without building an inventory. */
export function acceptedCellsIdentity(root, commit) {
  if (!HASH.test(commit ?? '')) throw new TypeError('accepted cells inventory needs an exact commit');
  const tree = git(root, ['rev-parse', `${commit}^{tree}`], { env: gitChildEnv(root) }).trim();
  if (!HASH.test(tree)) throw new Error('accepted cells inventory tree is unavailable');
  return { directory: join(machineHome(), 'cells-cache', 'accepted'), tree, checker: checkerFingerprint(), preloads: preloadFingerprint() };
}

/** Read only a complete matching artifact; missing or invalid evidence never runs analysis. */
export function readAcceptedCells(root, commit) {
  try {
    const identity = acceptedCellsIdentity(root, commit);
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

/** Build a verified accepted tree off-path, reusing the nearest compatible completed ancestor where possible. */
export async function warmAcceptedCells(root, commit, { withCheckout, withLock } = {}) {
  if (typeof withCheckout !== 'function' || typeof withLock !== 'function') throw new TypeError('accepted cells warm needs checkout and lock ports');
  git(root, ['merge-base', '--is-ancestor', commit, 'refs/heads/main'], { env: gitChildEnv(root) });
  if (!git(root, ['ls-tree', '--name-only', commit, '--', 'bin/cells-plan.json'], { env: gitChildEnv(root) })) return { available: false, cause: 'no-cells-plan' };
  const identity = acceptedCellsIdentity(root, commit), key = acceptedInventoryKey(identity);
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
  const result = await withCheckout(root, commit, checkout => warmAcceptedInventory({ ...identity, root: checkout, commit, withLock,
    parsers: { importsIn, commonJsIn }, withImportParseCache, eligible: () => preloadFingerprint() === originalPreloads,
    prior, onMode: value => { mode = value; } }));
  if (!result?.available) throw new Error(result?.unavailable ?? 'accepted cells inventory checkout failed');
  const file = join(identity.directory, `${key}.inventory.gz`), stat = lstatSync(file);
  save(join(identity.directory, `${key}.ready.json`), { version: 1, tree: identity.tree, key, bytes: stat.size, modified: stat.mtimeMs, digest: result.descriptor.digest, mode, ancestor: prior?.commit ?? null });
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
  if (!git(root, ['ls-tree', '--name-only', commit, '--', 'bin/cells-plan.json'], { env: gitChildEnv(root) })) return null;
  const identity = acceptedCellsIdentity(root, commit), key = acceptedInventoryKey(identity), directory = identity.directory;
  return withFileLock(join(directory, `${key}.owner-lock.sqlite`), async () => {
    const artifact = join(directory, `${key}.inventory.gz`), readyFile = join(directory, `${key}.ready.json`), ownerFile = join(directory, `${key}.owner.json`);
    try {
      const ready = JSON.parse(readFileSync(readyFile, 'utf8')), stat = lstatSync(artifact);
      if (ready.version === 1 && ready.key === key && ready.tree === identity.tree && stat.isFile() && !stat.isSymbolicLink()
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
  try { identity = acceptedCellsIdentity(root, commit); key = acceptedInventoryKey(identity); }
  catch { identity = { directory: join(machineHome(), 'cells-cache', 'accepted'), tree: null }; key = HASH.test(commit ?? '') ? commit : 'unknown'; }
  save(join(identity.directory, `${key}.failure.json`), { version: 1, tree: identity.tree, at: new Date().toISOString(), message: String(error?.message ?? error).slice(0, 2048) });
}
