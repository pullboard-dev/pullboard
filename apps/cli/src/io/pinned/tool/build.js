/** Immutable board-local tool installations; project source and the command's cwd never move. */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { randomUUID } from 'node:crypto';
import { environmentAdapter } from '../../../../../../packages/env/index.js';
import { inflateSync } from 'node:zlib';
// Use the public browser-safe door to keep the thin resident client from loading the full kernel.
import {
  CONFIG_FILE,
  isConfigFile,
  Refused,
} from '../../../../../../packages/kernel/browser.js';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Read Git without inheriting a caller's alternate index or repository selector. */
function git(root, args, binary = false) {
  const env = environmentAdapter().all();
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const result = spawnSync('git', ['--no-replace-objects', ...args], { cwd: root, env,
    encoding: binary ? undefined : 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Refused('TOOL_BUILD_UNAVAILABLE', 'restore the published tool build Git objects, or ask the coordinator to promote a gated build');
  return binary ? result.stdout : result.stdout.trim();
}

/**
 * Answer the repository location from Git's own files, or null when only Git can: an alternate selector,
 * a separate work tree, a bare setting or anything unreadable. Why: this runs on every command's path, and a
 * Git child costs more than reading two small files [C7].
 */
function fileLocation(cwd) {
  try {
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) if (environmentAdapter().has(name)) return null;
    let top = realpathSync(cwd);
    while (!existsSync(join(top, '.git'))) {
      const parent = dirname(top);
      if (parent === top) return null;
      top = parent;
    }
    let gitDir = join(top, '.git');
    let commonDir = gitDir;
    if (!statSync(gitDir).isDirectory()) {
      const pointer = /^gitdir: (.+)$/mu.exec(readFileSync(gitDir, 'utf8'));
      if (!pointer) return null;
      gitDir = realpathSync(resolve(top, pointer[1].trim()));
      commonDir = realpathSync(resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()));
    }
    commonDir = realpathSync(commonDir);
    const config = readFileSync(join(commonDir, 'config'), 'utf8');
    if (/^\s*worktree\s*=/imu.test(config) || /^\s*bare\s*=\s*(?:true|yes|on|1)\s*$/imu.test(config)
      || /objectformat\s*=\s*sha256/iu.test(config) || /^\s*\[extensions\]/imu.test(config) && /refstorage/iu.test(config)
      || existsSync(join(gitDir, 'config.worktree'))) return null;
    return { root: top, commonDir, directory: join(commonDir, 'pullboard', 'tool-builds') };
  } catch { return null; }
}

/** Read one loose Git object's body, or null when it is packed or absent so Git itself must answer. */
function looseObject(commonDir, oid) {
  try {
    const raw = inflateSync(readFileSync(join(commonDir, 'objects', oid.slice(0, 2), oid.slice(2))));
    const end = raw.indexOf(0);
    return { type: raw.subarray(0, raw.indexOf(32)).toString(), body: raw.subarray(end + 1) };
  } catch { return null; }
}

/** Resolve the primary checkout's HEAD commit from loose or packed refs; undefined when Git must answer. */
function primaryHead(commonDir) {
  try {
    // A real refs/main-worktree/HEAD would outrank the pseudo-ref, so only Git can name the commit then.
    if (existsSync(join(commonDir, 'refs', 'main-worktree', 'HEAD'))
      || /^[a-f0-9]+ refs\/main-worktree\/HEAD$/mu.test(existsSync(join(commonDir, 'packed-refs')) ? readFileSync(join(commonDir, 'packed-refs'), 'utf8') : '')) return undefined;
    const head = readFileSync(join(commonDir, 'HEAD'), 'utf8').trim();
    if (/^[a-f0-9]{40}$/u.test(head)) return head;
    const name = /^ref: (refs\/.+)$/u.exec(head)?.[1];
    if (!name) return undefined;
    if (existsSync(join(commonDir, name))) {
      const value = readFileSync(join(commonDir, name), 'utf8').trim();
      return /^[a-f0-9]{40}$/u.test(value) ? value : undefined;
    }
    for (const line of readFileSync(join(commonDir, 'packed-refs'), 'utf8').split('\n')) {
      const [oid, ref] = line.split(' ');
      if (ref === name && /^[a-f0-9]{40}$/u.test(oid)) return oid;
    }
  } catch { /* Fall through to Git. */ }
  return undefined;
}

/** Read pullboard.json at the primary checkout's HEAD from loose objects; undefined when Git must answer, null when absent. */
function committedConfigFromObjects(commonDir) {
  const commit = primaryHead(commonDir);
  if (!commit) return undefined;
  const parsed = looseObject(commonDir, commit);
  const tree = parsed?.type === 'commit' ? /^tree ([a-f0-9]{40})$/mu.exec(parsed.body.toString('latin1'))?.[1] : null;
  const root = tree && looseObject(commonDir, tree);
  if (root?.type !== 'tree') return undefined;
  const bytes = root.body;
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at), nul = bytes.indexOf(0, space);
    if (space < 0 || nul < 0) return undefined;
    const name = bytes.subarray(space + 1, nul).toString();
    const oid = bytes.subarray(nul + 1, nul + 21).toString('hex');
    at = nul + 21;
    if (!isConfigFile(name)) continue;
    const blob = looseObject(commonDir, oid);
    return blob?.type === 'blob' ? blob.body.toString('utf8') : undefined;
  }
  return null;
}

/** Locate shared storage before loading any live-trunk configuration parser. */
export function toolBuildLocation(cwd) {
  // A worktree needs a .git marker in its ancestry unless Git was explicitly pointed elsewhere.
  // Avoid starting Git for ordinary help from a directory that cannot contain a board.
  if (!environmentAdapter().get('GIT_DIR')) {
    let directory;
    try { directory = realpathSync(cwd); } catch { directory = null; }
    while (directory && !existsSync(join(directory, '.git'))) {
      const parent = dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }
  const located = fileLocation(cwd);
  if (located) return located;
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0) return null;
  const [root, commonDir] = result.stdout.trim().split('\n');
  if (!root || !commonDir) return null;
  return { root, commonDir, directory: join(commonDir, 'pullboard', 'tool-builds') };
}

/** Read only this bootstrap's setting from the primary committed config; newer unrelated keys stay opaque. */
export function toolBuildPolicy(location) {
  let raw;
  const committed = committedConfigFromObjects(location.commonDir);
  if (committed === null) return { enabled: false, refreshMs: 3_600_000 };
  try { raw = JSON.parse(committed ?? git(location.root, ['show', `main-worktree/HEAD:${CONFIG_FILE}`])); }
  catch { return { enabled: false, refreshMs: 3_600_000 }; }
  const value = raw.toolBuild;
  if (value === undefined) return { enabled: false, refreshMs: 3_600_000 };
  if (!value || typeof value.enabled !== 'boolean' || value.refreshMs !== undefined
    && (!Number.isSafeInteger(value.refreshMs) || value.refreshMs < 1)) {
    throw new Refused('BAD_CONFIG', 'toolBuild needs enabled true|false and an optional positive refreshMs');
  }
  return { enabled: value.enabled, refreshMs: value.refreshMs ?? 3_600_000 };
}

/** Read the atomically published selection; absent and malformed selections cannot silently run trunk. */
export function readToolBuild(location) {
  const path = join(location.directory, 'current.json');
  if (!existsSync(path)) return null;
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { value = null; }
  if (value?.version !== 1 || !OID.test(value.commit ?? '') || !OID.test(value.tree ?? '')
    || !Number.isFinite(Date.parse(value.promotedAt)) || typeof value.receipt !== 'string') {
    throw new Refused('TOOL_BUILD_UNAVAILABLE', 'the published tool build is malformed; ask the coordinator to promote a gated build');
  }
  return value;
}

/** Export an exact immutable commit into a private cache, publishing only a completed installation. */
export function installToolBuild(location, build) {
  const target = join(location.directory, build.commit);
  if (existsSync(target)) return target;
  mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(location.directory, '.install-'));
  try {
    if (git(location.root, ['rev-parse', `${build.commit}^{tree}`]) !== build.tree) {
      throw new Refused('TOOL_BUILD_UNAVAILABLE', 'the published tool tree does not match its commit; promote a gated build');
    }
    const archive = git(location.root, ['archive', '--format=tar', build.commit], true);
    const unpacked = spawnSync('tar', ['-xf', '-', '-C', temporary], { input: archive, encoding: 'utf8' });
    if (unpacked.status !== 0 || !existsSync(join(temporary, 'apps/cli/pullboard.js'))) {
      throw new Refused('TOOL_BUILD_UNAVAILABLE', 'the gated commit is not an installable Pullboard build; promote a Pullboard commit');
    }
    try { renameSync(temporary, target); }
    catch (error) { if (!existsSync(target)) throw error; }
    return target;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Atomically publish a validated build; readers already running retain their installation. */
export function writeToolBuild(location, build) {
  installToolBuild(location, build);
  const temporary = join(location.directory, `.current-${randomUUID()}`);
  try {
    writeFileSync(temporary, `${JSON.stringify(build)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(location.directory, 'current.json'));
  } finally { rmSync(temporary, { force: true }); }
  return build;
}

/** Select at command entry only; the immutable module root also pins all subsequent runner imports. The policy is read once: each read is a Git spawn on every command's path [C7]. */
export async function selectedToolEntry(cwd, entry, { now = Date.now() } = {}) {
  const location = toolBuildLocation(cwd);
  if (!location) return null;
  const policy = toolBuildPolicy(location);
  if (!policy.enabled) return null;
  let build = readToolBuild(location);
  if (!build || now - Date.parse(build.promotedAt) >= policy.refreshMs) {
    const { refreshToolBuild } = await import('./publish.js');
    build = refreshToolBuild(location, { now }) ?? build;
  }
  if (!build) throw new Refused('TOOL_BUILD_REQUIRED', 'pinned tools are enabled but no gated build is published; coordinator: run pullboard tool-build promote <commit> --gate-receipt <gate-id>');
  const selected = join(installToolBuild(location, build), 'apps/cli/pullboard.js');
  return resolve(selected) === resolve(entry) ? null : selected;
}

/** Name the published selection and the immutable module generation actually serving this command. */
export function toolBuildHealth(cwd, moduleRoot, now = Date.now()) {
  const location = toolBuildLocation(cwd);
  if (!location) return { enabled: false, build: null };
  const policy = toolBuildPolicy(location), build = readToolBuild(location);
  const prefix = resolve(location.directory) + '/';
  const path = resolve(moduleRoot);
  const runningCommit = path.startsWith(prefix) ? path.slice(prefix.length).split('/')[0] : null;
  return { ...policy, build, runningCommit, ageMs: build ? Math.max(0, now - Date.parse(build.promotedAt)) : null };
}
