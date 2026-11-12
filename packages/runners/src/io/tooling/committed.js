/** Export runner controllers from immutable Git objects, independently of checkout edits [O5,C7]. */
import { gitSpawnSync } from '../../../../git/index.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { Refused } from '../../../../kernel/index.js';
import { dropStagingFolder } from '../keyed.js';
import { placeKeyedFolder } from '../keyed.js';
import { touchKeyedFolder } from '../keyed.js';
import { writeKeyedLease } from '../keyed.js';
import { scratchFolder } from '../../../../config/index.js';
import { scratchRoot } from '../../../../config/index.js';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MANIFEST = '.pullboard-runner-source.json';

/** Read literal Git objects without project-selected repositories, replacement objects or filters. */
function toolingGit(root, args, binary = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const result = gitSpawnSync(['--no-replace-objects', ...args], { cwd: root, env,
    encoding: binary ? undefined : 'utf8', maxBuffer: 128 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Refused('RUNNER_TOOLING_FILES', 'selected runner tooling Git objects are unavailable; restore the committed tooling installation');
  return binary ? result.stdout : result.stdout.trim();
}

/** Retain exact Git provenance for an owned archive without treating its metadata as byte authority. */
export function archivedToolingSource(root) {
  const file = join(root, MANIFEST);
  if (!existsSync(file)) return null;
  let source;
  try { source = JSON.parse(readFileSync(file, 'utf8')); } catch { source = null; }
  if (!source || Object.keys(source).sort().join(',') !== 'commit,root,tree,version' || source.version !== 1
    || typeof source.root !== 'string' || !isAbsolute(source.root) || !OID.test(source.commit ?? '') || !OID.test(source.tree ?? '')
    || toolingGit(source.root, ['rev-parse', `${source.commit}^{tree}`]) !== source.tree) {
    throw new Refused('RUNNER_TOOLING_CHANGED', 'archived runner tooling provenance is invalid; restart from the committed installation');
  }
  return source;
}

/** The prefix of every committed controller folder; a shared one adds its 32-hex key. */
const PREFIX = 'pullboard-committed-runner-';
/** The most shared controller folders left in the temp directory after a sweep, newest kept. */
export const SHARED_KEEP_COUNT = 8;
/** Shared folders this process is running from, by path, with their run counts; a sweep never removes one. */
const inUse = new Map();
/** The folder beside the shared exports holding one empty lease file per export and process: `<key>.<pid>`. */
const LEASES = 'pullboard-committed-leases';

/** This process's lease file on a shared folder. */
function leaseFile(directory, pid = process.pid) {
  return join(dirname(directory), LEASES, `${basename(directory).slice(PREFIX.length)}.${pid}`);
}

/**
 * Whether another live process holds a lease on a shared folder; a dead process's lease is removed on sight.
 * Why: the folder is shared by every process of this user, and this process's own counts cannot see theirs (#5925).
 */
function heldElsewhere(directory) {
  const folder = join(dirname(directory), LEASES);
  const key = `${basename(directory).slice(PREFIX.length)}.`;
  let names = [];
  try { names = readdirSync(folder); } catch { return false; }
  for (const name of names) {
    if (!name.startsWith(key)) continue;
    const pid = Number(name.slice(key.length));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try { process.kill(pid, 0); return true; } catch (error) {
      if (error.code === 'EPERM') return true;
      try { rmSync(join(folder, name), { force: true }); } catch { /* another sweep */ }
    }
  }
  return false;
}

/** Count one more run on a shared folder; the first also leases it for this process, before any check of it. */
function acquire(directory) {
  const count = inUse.get(directory) ?? 0;
  if (count === 0) {
    const file = leaseFile(directory);
    writeKeyedLease(dirname(file), basename(file));
  }
  inUse.set(directory, count + 1);
}

/** Count a run finished without removing the folder; its last run drops this process's lease. Returns runs left. */
function unlease(directory) {
  const left = (inUse.get(directory) ?? 1) - 1;
  if (left > 0) { inUse.set(directory, left); return left; }
  inUse.delete(directory);
  rmSync(leaseFile(directory), { force: true });
  return 0;
}

/**
 * Count a run finished; the folder is removed with the last run of every process, so none lingers to churn the file
 * watcher (11 Nov). Why: the 6 h keep left 127 folders under load, and another process may still run from it (#5925).
 */
function release(directory) {
  if (unlease(directory) > 0 || heldElsewhere(directory)) return;
  rmSync(directory, { recursive: true, force: true });
}

/**
 * The shared export of one repository's commit when it is complete and this user's alone, else null. Why the checks: a
 * folder another user could write might hold a controller that is not this commit's, so it is never reused.
 */
function sharedExport(directory, root, commit, tree) {
  try {
    const state = statSync(directory);
    if (!state.isDirectory() || state.uid !== process.getuid?.() || (state.mode & 0o022) !== 0) return null;
    const source = JSON.parse(readFileSync(join(directory, MANIFEST), 'utf8'));
    if (source.version !== 1 || source.root !== resolve(root) || source.commit !== commit || source.tree !== tree
      || !existsSync(join(directory, 'apps/runner/src/io/controller.js'))) return null;
    touchKeyedFolder(directory);
    return directory;
  } catch { return null; }
}

/** Remove all but the newest SHARED_KEEP_COUNT shared controller folders, never one in use here or elsewhere, or `keep`. */
export function pruneSharedExports(keep, parent = scratchRoot()) {
  const shared = new RegExp(`^${PREFIX}[a-f0-9]{32}$`, 'u');
  let names = [];
  try { names = readdirSync(parent); } catch { return []; }
  const found = [];
  for (const name of names) {
    if (!shared.test(name)) continue;
    try { found.push({ path: join(parent, name), name, mtime: statSync(join(parent, name)).mtimeMs }); } catch { /* gone */ }
  }
  found.sort((x, y) => y.mtime - x.mtime);
  const removed = [];
  for (const { path, name } of found.slice(SHARED_KEEP_COUNT)) {
    if (path === keep || inUse.has(path) || heldElsewhere(path)) continue;
    try { rmSync(path, { recursive: true, force: true }); removed.push(name); } catch { /* another sweep */ }
  }
  return removed;
}

/**
 * Make one owned git-archive installation; callers drain their controller before removing it. With `shared`, the
 * export of a commit is made once and reused by every later dispatch of that commit, whose cleanup leaves it in place.
 * Why: every runner dispatch exported and unpacked the whole tooling tree twice, about a second each when idle and far
 * more at load, before it could connect (9 Nov) [C7]. A commit names its tree, so the export never changes.
 *
 * @param {string} root
 * @param {{ shared?: boolean }} [options]
 */
export function committedRunnerController(root, { shared = false } = {}) {
  if (!existsSync(join(root, '.git'))) return null;
  const commit = toolingGit(root, ['rev-parse', '--verify', 'HEAD']);
  const tree = toolingGit(root, ['rev-parse', `${commit}^{tree}`]);
  if (!OID.test(commit) || !OID.test(tree) || toolingGit(root, ['rev-parse', '--show-toplevel']) !== resolve(root)) {
    throw new Refused('RUNNER_TOOLING_FILES', 'runner tooling must name its exact committed repository');
  }
  const target = shared ? join(scratchRoot(), PREFIX + createHash('sha256').update(`${resolve(root)}\0${commit}`).digest('hex').slice(0, 32)) : null;
  // Leased before it is checked, so a process releasing it concurrently sees this one and leaves it.
  if (target) acquire(target);
  const reused = target && sharedExport(target, root, commit, tree);
  const handle = path => { let done = false; return () => { if (!done) { done = true; release(path); } }; };
  if (reused) {
    const cleanup = handle(reused);
    return { root: reused, entry: join(reused, 'apps/runner/src/io/controller.js'), commit, tree, cleanup };
  }
  const directory = scratchFolder(PREFIX);
  try {
    // A repository's local attributes and CRLF filters can alter git-archive bytes too. An
    // isolated object view overrides every conversion without touching the user's Git settings.
    const objects = toolingGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
    const metadata = join(directory, '.objects');
    toolingGit(root, ['init', '--quiet', '--bare', metadata]);
    writeFileSync(join(metadata, 'objects/info/alternates'), `${objects}\n`, { flag: 'wx' });
    mkdirSync(join(metadata, 'info'), { recursive: true });
    writeFileSync(join(metadata, 'info/attributes'), '* -text -filter -ident -export-subst -export-ignore\n', { flag: 'wx' });
    const archive = toolingGit(root, ['--git-dir', metadata, '-c', 'core.autocrlf=false',
      '-c', 'core.attributesFile=/dev/null', 'archive', '--format=tar', commit], true);
    const unpacked = spawnSync('tar', ['-xf', '-', '-C', directory], { input: archive, encoding: 'utf8' });
    if (unpacked.status !== 0 || !existsSync(join(directory, 'apps/runner/src/io/controller.js'))) {
      throw new Refused('RUNNER_TOOLING_FILES', 'the selected Git archive has no runner controller; restore committed tooling');
    }
    writeFileSync(join(directory, MANIFEST), JSON.stringify({ version: 1, root: resolve(root), commit, tree }), { flag: 'wx', mode: 0o400 });
    if (target) {
      // Renamed into place whole, so no dispatch sees half an export; a concurrent export that won the rename is the
      // same commit. A folder in the way that is not this commit's own leaves this export private, as before.
      const moved = placeKeyedFolder(directory, target);
      const placed = sharedExport(target, root, commit, tree);
      if (placed) {
        if (!moved) dropStagingFolder(directory);
        const cleanup = handle(placed);
        pruneSharedExports(placed);
        return { root: placed, entry: join(placed, 'apps/runner/src/io/controller.js'), commit, tree, cleanup };
      }
      if (moved) throw new Refused('RUNNER_TOOLING_FILES', 'the shared runner tooling export could not be read back; retry from the committed installation');
      unlease(target);
    }
    return { root: directory, entry: join(directory, 'apps/runner/src/io/controller.js'), commit, tree,
      cleanup() { rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    if (target && inUse.has(target)) unlease(target);
    throw error;
  }
}
