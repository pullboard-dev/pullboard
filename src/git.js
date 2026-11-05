/**
 * The few Git facts pullboard needs: repository/worktree identity, selected refs and tree cleanliness.
 */
import {
  execFileSync,
  spawnSync,
} from './windows-child-process.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
  isAbsolute,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from './refused.js';

const GIT_FLAGS = ['--no-replace-objects', '-c', 'core.quotepath=false'];
const gitFacts = new AsyncLocalStorage();
const gitReadFacts = new AsyncLocalStorage();
const READ_FACT_LIMIT = 512;
const persistentReadFacts = new Map();
/** Inherited Git variables that select another repository, index, object store or configuration. */
const INHERITED_SELECTORS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE'];

/** Mark API read work so selected facts use the bounded process-lifetime, filesystem-validated cache.
 *
 * @param {() => any} work
 * @returns {any}
 */
export function withGitReadFacts(work) {
  return gitReadFacts.run(true, work);
}

/** Reuse facts within one CLI invocation, while isolating concurrent commands and expiring settled ones.
 *
 * @param {() => unknown} work
 * @param {{ resumeSources?: boolean }} [options] permit pinned source facts only for an explicit resume scope
 * @returns {Promise<unknown>}
 */
export async function withGitFacts(work, { resumeSources = false } = {}) {
  const cache = { active: true, facts: new Map(), resumeSources };
  const run = () => gitFacts.run(cache, async () => {
    try { return await work(); }
    finally {
      cache.active = false;
      cache.facts.clear();
    }
  });
  // CLI authority must always use fresh Git facts, even when invoked from an API read callback.
  return gitReadFacts.getStore() === true ? gitReadFacts.run(null, run) : run();
}

/** Set the already parsed command intent before its first repository lookup, without creating a new cache. */
export function setResumeSourceFacts(enabled) {
  const cache = gitFacts.getStore();
  if (cache?.active) cache.resumeSources = enabled === true;
}

/** Drop facts after this command changes Git state such as refs, configuration, or worktrees. */
export function invalidateGitFacts() {
  gitFacts.getStore()?.facts.clear();
  persistentReadFacts.clear();
}

/** Recognize only the known null device whose timestamps change as unrelated readers touch it. */
function isNullDevice(stat, path) {
  return stat.isCharacterDevice() && path === '/dev/null';
}

/** Return a stable, cheap signature for a path, including file contents against coarse timestamps. */
function fileSignature(path, includeContents = true) {
  try {
    const stat = lstatSync(path, { bigint: true });
    const nullDevice = isNullDevice(stat, path);
    let target = null;
    let targetIsFile = false;
    if (stat.isSymbolicLink()) {
      try {
        const followed = statSync(path, { bigint: true });
        const targetPath = realpathSync.native(path);
        const targetIsNullDevice = isNullDevice(followed, targetPath);
        target = [String(followed.dev), String(followed.ino), String(followed.mode), String(followed.size),
          targetIsNullDevice ? null : String(followed.mtimeNs), targetIsNullDevice ? null : String(followed.ctimeNs)];
        targetIsFile = followed.isFile();
      } catch (error) {
        target = ['unreadable', error.code ?? 'ERROR'];
      }
    }
    let contents = null;
    if (includeContents && (stat.isFile() || targetIsFile)) contents = readFileSync(path, 'utf8');
    // /dev/null's device timestamps advance on reads; its stable identity is enough for config context.
    return [String(stat.dev), String(stat.ino), String(stat.mode), String(stat.size),
      nullDevice ? null : String(stat.mtimeNs), nullDevice ? null : String(stat.ctimeNs), contents, target];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    return ['unreadable', error.code ?? 'ERROR'];
  }
}

/** Refuse caching for config includes or any explicit ref backend selection this signature cannot track. */
function configNeedsFallback(path, { attribution = false } = {}) {
  try {
    const source = readFileSync(path, 'utf8');
    return /^\s*\[\s*include(?:if\b|[\s\]])/imu.test(source)
      || /(?:^|\])\s*refstorage\s*=/imu.test(source)
      || (attribution && (/^\s*\[\s*(?:blame|mailmap|filter|diff)(?:\s|\])/imu.test(source)
        || /(?:^|\])\s*attributesfile\s*=/imu.test(source)));
  } catch (error) {
    return error.code !== 'ENOENT' && error.code !== 'ENOTDIR';
  }
}

/** Describe worktree discovery and ref files without invoking Git, so a warm read can validate facts. */
function repositorySignature(cwd, info = null, includeHead = false, { attribution = false } = {}) {
  const markers = [];
  try { markers.push(['physical-cwd', realpathSync.native(cwd)]); }
  catch (error) { markers.push(['physical-cwd', error.code ?? 'ERROR']); }
  let folder = resolve(cwd);
  let discoveredGitDir = null;
  let discoveredCommonDir = null;
  while (true) {
    const markerPath = join(folder, '.git');
    const marker = fileSignature(markerPath);
    markers.push([markerPath, marker]);
    if (marker) {
      if (info && folder === resolve(info.root)) {
        discoveredGitDir = info.gitDir;
        discoveredCommonDir = info.commonDir;
      } else {
        let isDirectory = marker[2] && (BigInt(marker[2]) & 0o170000n) === 0o040000n;
        if (!isDirectory) {
          try { isDirectory = statSync(markerPath).isDirectory(); } catch { /* Git reports malformed or missing metadata. */ }
        }
        if (isDirectory) {
          try {
            discoveredGitDir = realpathSync.native(markerPath);
            discoveredCommonDir = discoveredGitDir;
          } catch {
            discoveredGitDir = null;
            discoveredCommonDir = null;
          }
        } else if (typeof marker[6] === 'string') {
          const pointer = /^gitdir: (.+)\n?$/u.exec(marker[6]);
          if (pointer) {
            try {
              discoveredGitDir = realpathSync.native(resolve(folder, pointer[1]));
              const common = fileSignature(join(discoveredGitDir, 'commondir'));
              discoveredCommonDir = common?.[6]
                ? realpathSync.native(resolve(discoveredGitDir, common[6].trim()))
                : discoveredGitDir;
            } catch {
              // Let Git's normal reader report malformed or inaccessible worktree metadata.
              discoveredGitDir = null;
              discoveredCommonDir = null;
            }
          }
        }
      }
      break;
    }
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  const rootPath = info?.root ?? folder;
  const gitDir = info?.gitDir ?? discoveredGitDir;
  const commonDir = info?.commonDir ?? discoveredCommonDir;
  if (!gitDir || !commonDir) return includeHead ? null : JSON.stringify(markers);
  const configPaths = [join(gitDir, 'config'), join(commonDir, 'config'), join(gitDir, 'config.worktree')];
  if (configPaths.some(path => configNeedsFallback(path, { attribution }))) return null;
  for (const path of [rootPath, gitDir, commonDir]) markers.push([path, fileSignature(path, false)]);
  for (const path of [join(gitDir, 'commondir'), ...configPaths]) {
    markers.push([path, fileSignature(path, attribution || basename(path) === 'commondir')]);
  }
  if (includeHead) {
    const headPath = join(gitDir, 'HEAD');
    const headMark = fileSignature(headPath);
    markers.push([headPath, headMark]);
    const head = headMark?.[6];
    const symbolic = typeof head === 'string' ? /^ref: (.+)\n?$/u.exec(head) : null;
    if (symbolic) {
      const ref = symbolic[1];
      if (!ref.startsWith('refs/') || ref.includes('\\')
        || !ref.split('/').every((part) => part && part !== '.' && part !== '..')) return null;
      for (const path of [join(gitDir, ref), join(commonDir, ref), join(commonDir, 'packed-refs')]) {
        const marker = fileSignature(path, path !== join(commonDir, 'packed-refs'));
        markers.push([path, marker]);
        if (marker?.[6]?.startsWith('ref: ')) return null;
      }
    }
  }
  if (attribution) {
    const index = process.env.GIT_INDEX_FILE ? resolve(cwd, process.env.GIT_INDEX_FILE) : join(gitDir, 'index');
    markers.push([index, fileSignature(index, false)]);
    for (const path of [join(commonDir, 'shallow'), join(commonDir, 'info', 'grafts'), join(commonDir, 'info', 'attributes')]) {
      markers.push([path, fileSignature(path)]);
    }
  }
  return JSON.stringify(markers);
}

/** Whether every GIT_CONFIG_KEY_n override is one that selects no repository or Git object. */
function safeConfigOverrides(env, count) {
  // Identity validation and automatic housekeeping do not select repositories or Git objects.
  const safeOverrides = new Set(['user.useconfigonly', 'gc.auto', 'maintenance.auto']);
  for (let index = 0; index < count; index += 1) {
    const key = env[`GIT_CONFIG_KEY_${index}`];
    const value = env[`GIT_CONFIG_VALUE_${index}`];
    if (!key || value === undefined || !safeOverrides.has(key.toLowerCase())) return false;
  }
  return true;
}

/**
 * Whether Git run with this process's environment sees the same repository and refs as with a clean one: nothing
 * selects another repository, object store or configuration, and config overrides are housekeeping only.
 */
function plainRepositoryEnvironment(env = process.env) {
  if (INHERITED_SELECTORS.some((key) => !['GIT_CONFIG_COUNT', 'GIT_INDEX_FILE', 'GIT_PREFIX'].includes(key) && env[key] !== undefined)) return false;
  const count = env.GIT_CONFIG_COUNT === undefined ? 0 : Number(env.GIT_CONFIG_COUNT);
  return Number.isSafeInteger(count) && count >= 0 && count <= 16 && safeConfigOverrides(env, count);
}

/** Describe relevant Git environment/config so harmless process settings can still share read facts. */
function readCacheContext({ attribution = false } = {}) {
  const env = process.env;
  if (attribution && (env.GIT_NAMESPACE || Object.keys(env).some(name => name.startsWith('GIT_ATTR_')))) return null;
  const discoverySelectors = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_IMPLICIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE'];
  if (discoverySelectors.some((name) => env[name] !== undefined && env[name] !== '')) return null;

  const names = Object.keys(env).filter((name) => name === 'GIT_CONFIG' || name === 'GIT_CONFIG_PARAMETERS'
    || name === 'GIT_CONFIG_COUNT' || name === 'GIT_CONFIG_GLOBAL' || name === 'GIT_CONFIG_SYSTEM'
    || name === 'GIT_CONFIG_NOSYSTEM' || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)).sort();
  const values = names.map((name) => [name, env[name]]);
  if (env.GIT_CONFIG_PARAMETERS) return null;
  const count = env.GIT_CONFIG_COUNT === undefined ? 0 : Number(env.GIT_CONFIG_COUNT);
  if (!Number.isSafeInteger(count) || count < 0 || count > 16) return null;
  if (!safeConfigOverrides(env, count)) return null;
  const files = new Set();
  if (env.GIT_CONFIG) files.add(env.GIT_CONFIG);
  if (env.GIT_CONFIG_GLOBAL) files.add(env.GIT_CONFIG_GLOBAL);
  else {
    const xdg = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : null);
    if (xdg) files.add(join(xdg, 'git', 'config'));
    if (env.HOME) files.add(join(env.HOME, '.gitconfig'));
  }
  if (env.GIT_CONFIG_NOSYSTEM !== '1') {
    if (env.GIT_CONFIG_SYSTEM) files.add(env.GIT_CONFIG_SYSTEM);
    else if (process.platform !== 'win32') files.add('/etc/gitconfig');
  }
  if (attribution) {
    const xdg = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : null);
    if (xdg) files.add(join(xdg, 'git', 'attributes'));
    for (const path of ['/etc/gitattributes', '/usr/local/etc/gitattributes', '/opt/homebrew/etc/gitattributes']) files.add(path);
  }
  const paths = [...files].sort();
  if (paths.some(path => configNeedsFallback(path, { attribution }))) return null;
  const fileMarkers = paths.map((path) => [path, fileSignature(path, attribution)]);
  return JSON.stringify({ cwd: process.cwd(), values, home: env.HOME ?? null, xdg: env.XDG_CONFIG_HOME ?? null, files: fileMarkers });
}

/** Describe a stable read input without Git processes; unsupported attribution settings disable reuse. */
export function gitReadSignature(root, files, { attribution = false } = {}) {
  const context = readCacheContext({ attribution });
  const repository = repositorySignature(root, null, true, { attribution });
  if (context === null || repository === null) return null;
  const paths = new Set(files.map(file => join(root, file)));
  if (attribution) {
    for (const file of files) {
      let folder = dirname(resolve(root, file));
      while (folder === resolve(root) || folder.startsWith(resolve(root) + sep)) {
        paths.add(join(folder, '.gitattributes'));
        if (folder === resolve(root)) break;
        folder = dirname(folder);
      }
    }
  }
  const inputs = [...paths].map(path => [path, fileSignature(path)]);
  return createHash('sha256').update(JSON.stringify([context, repository, inputs])).digest('hex');
}

/** Return a validated cached read fact, refreshing it when its filesystem signature changes. */
function readFact(key, signature, read) {
  if (gitReadFacts.getStore() !== true) return read();
  const context = readCacheContext();
  if (context === null) return read();
  key = `${context}\0${key}`;
  const cached = persistentReadFacts.get(key);
  const before = signature(cached?.value);
  if (before === null) return read();
  if (cached && cached.signature === before) {
    persistentReadFacts.delete(key);
    persistentReadFacts.set(key, cached);
    return cached.value;
  }
  const value = read();
  const after = signature(value);
  if (before === after) {
    persistentReadFacts.delete(key);
    persistentReadFacts.set(key, { signature: after, value });
    while (persistentReadFacts.size > READ_FACT_LIMIT) persistentReadFacts.delete(persistentReadFacts.keys().next().value);
  } else {
    persistentReadFacts.delete(key);
  }
  return value;
}

/** Return one cached value for this command, or compute it when no command scope is active.
 *
 * @param {string} key
 * @param {() => any} read
 * @returns {any}
 */
function fact(key, read) {
  const cache = gitFacts.getStore();
  if (!cache?.active) return read();
  if (cache.facts.has(key)) return cache.facts.get(key);
  const value = read();
  cache.facts.set(key, value);
  return value;
}

/** Read one Git config value with its status, reusing the same query for this command.
 *
 * @param {string} root
 * @param {string} key
 * @param {{ local?: boolean, clean?: boolean, flags?: boolean, noReplace?: boolean }} [options]
 * @returns {{ status: number, stdout: string }}
 */
export function gitConfig(root, key, { local = false, clean = false, flags = true, noReplace = false } = {}) {
  const args = [...(noReplace ? ['--no-replace-objects'] : []), ...(flags ? GIT_FLAGS : []), 'config', ...(local ? ['--local'] : []), '--get', key];
  const cacheKey = JSON.stringify(['config', resolve(root), args, clean]);
  return fact(cacheKey, () => {
    const result = spawnSync('git', args, { cwd: root, env: clean ? cleanGitEnvironment() : process.env, encoding: 'utf8' });
    return { status: result.status ?? 1, stdout: (result.stdout ?? '').trim() };
  });
}

/** Git operations whose successful completion can change a cached repository fact. */
function changesGitFacts(args) {
  const words = args.filter((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-c');
  const [command, subcommand] = words;
  if (['checkout', 'switch', 'commit', 'reset', 'update-ref', 'merge', 'rebase', 'cherry-pick', 'stash'].includes(command)) return true;
  if (command === 'worktree') return ['add', 'remove', 'prune', 'move', 'lock', 'unlock'].includes(subcommand);
  if (command === 'config') return !args.some((arg) => ['--get', '--get-all', '--get-regexp', '--list', '--show-origin', '--show-scope'].includes(arg));
  if (command === 'branch') return !args.includes('--list') && !args.includes('-a') && !args.includes('-r');
  if (command === 'symbolic-ref') return !args.some((arg) => ['--quiet', '-q', '--short'].includes(arg));
  return false;
}

/** Clear inherited Git selectors while retaining ordinary user settings and exact-object behavior.
 *
 * @returns {NodeJS.ProcessEnv}
 */
export function cleanGitEnvironment() {
  const env = { ...process.env };
  for (const key of INHERITED_SELECTORS) delete env[key];
  delete env.GIT_NO_REPLACE_OBJECTS;
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(?:KEY|VALUE)_/.test(key)) delete env[key];
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return env;
}

/** Resolve the primary checkout's branch and commit without assuming its branch is named main.
 *
 * @param {string} root
 * @returns {{branch: string, commit: string|null}|null}
 */
export function mainCheckout(root) {
  return fact(`mainCheckout:${resolve(root)}`, () => readMainCheckout(root));
}

/** Read only source identities already captured by this command's combined Git lookup. */
export function mainSourceBlobs(root) {
  return gitFacts.getStore()?.facts.get(`mainSourceBlobs:${resolve(root)}`) ?? null;
}

/** Resolve the primary checkout without assuming its branch is named main.
 *
 * @param {string} root
 * @returns {{ branch: string, commit: string | null } | null}
 */
function readMainCheckout(root) {
  const env = cleanGitEnvironment();
  /** Run one Git lookup with the sanitized environment. */
  const gitCall = (args) => spawnSync('git', [...GIT_FLAGS, ...args], {
    cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const common = gitCall(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.status !== 0) throw new Refused('NO_POLICY', 'the primary checkout cannot be located; restore the repository and ask the coordinator to retry');
  const commonDir = common.stdout.trim();
  const symbolic = gitCall(['--git-dir', commonDir, 'symbolic-ref', '--quiet', 'HEAD']);
  if (symbolic.status === 1) return null;
  if (symbolic.status !== 0) throw new Refused('NO_POLICY', 'the primary checkout branch cannot be read; restore its Git metadata and ask the coordinator to retry');
  const branch = symbolic.stdout.trim();
  const resolved = gitCall(['--git-dir', commonDir, 'rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
  if (resolved.status !== 0 && resolved.status !== 1) throw new Refused('NO_POLICY', 'the primary checkout commit cannot be read; restore its Git objects and ask the coordinator to retry');
  return { branch, commit: resolved.status === 0 ? resolved.stdout.trim() : null };
}
const CODE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The environment for a gate or fixer: keep the user's settings, but remove Git's repository-local
 * variables so a child that changes folders cannot act on the hook's repository by accident.
 * Pullboard's own Git calls retain those variables, including a hook's staged index.
 *
 * @param {string} root
 * @returns {NodeJS.ProcessEnv}
 */
export function gitChildEnv(root) {
  const env = { ...process.env };
  const discoveryEnv = { ...env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete discoveryEnv[name];
  const result = spawnSync('git', ['rev-parse', '--local-env-vars'], {
    cwd: root,
    env: discoveryEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status === 0) for (const name of result.stdout.split('\n')) delete env[name];
  else for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[name];
  env.GIT_NO_REPLACE_OBJECTS = '1'; // Exact-tree receipts never resolve replacement refs.
  return env;
}

/**
 * Run git in `cwd` and return its trimmed output, or throw when git fails.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ maxBuffer?: number, env?: NodeJS.ProcessEnv }} [options] - Bound output captures for callers parsing larger diffs.
 * @returns {string}
 */
export function git(cwd, args, { maxBuffer, env = process.env } = {}) {
  try {
    return execFileSync('git', [...GIT_FLAGS, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
    }).trim();
  } finally {
    if (changesGitFacts(args)) invalidateGitFacts();
  }
}

/**
 * Run git in `cwd` and report how it went, without throwing.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function tryGit(cwd, args, { env = process.env } = {}) {
  const result = spawnSync('git', [...GIT_FLAGS, ...args], { cwd, env, encoding: 'utf8' });
  if (changesGitFacts(args)) invalidateGitFacts();
  return { status: result.status ?? 1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

/**
 * Compute the stable patch id for a commit range, or null when Git cannot produce one.
 *
 * @param {string} root
 * @param {string} base
 * @param {string} commit
 * @returns {string | null}
 */
export function patchId(root, base, commit) {
  const env = cleanGitEnvironment();
  const diff = spawnSync('git', [...GIT_FLAGS, 'diff', base, commit], { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (diff.status !== 0 || !diff.stdout) return null;
  const result = spawnSync('git', [...GIT_FLAGS, 'patch-id', '--stable'], { cwd: root, env, encoding: 'utf8', input: diff.stdout });
  return result.status === 0 ? result.stdout.trim().split(/\s+/u)[0] || null : null;
}

/**
 * Find a main checkout whose `.git/config` marks it bare despite files beside its git directory.
 * This check uses the filesystem and explicit config path so inherited Git repository variables
 * cannot hide a damaged checkout from the command that needs to explain its repair.
 *
 * @param {string} cwd
 * @returns {{ code: string, message: string, next: string } | null}
 */
export function bareWorktreeFinding(cwd) {
  let root = resolve(cwd);
  while (true) {
    const gitDir = join(root, '.git');
    if (existsSync(gitDir)) {
      try {
        if (!statSync(gitDir).isDirectory()) return null;
        if (readdirSync(root).some((entry) => entry !== '.git')) {
          const bare = tryGit(root, ['config', '--file', join(gitDir, 'config'), '--bool', '--get', 'core.bare']);
          if (bare.status === 0 && bare.stdout === 'true') {
            const quotedGitDir = `'${gitDir.replaceAll("'", "'\\''")}'`;
            return {
              code: 'CORE_BARE',
              message: `main checkout ${root} has .git/config core.bare=true while working files are present beside .git`,
              next: `git --git-dir=${quotedGitDir} config core.bare false`,
            };
          }
        }
      } catch {
        // An unreadable nearest git directory cannot establish that this is the broken checkout.
      }
      return null;
    }
    const parent = dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

/**
 * The repo around `cwd`: its worktree root, the shared git dir, this worktree's git dir, and
 * whether this is the main checkout.
 *
 * The main checkout's git dir is the common dir; a linked worktree has its own under it.
 *
 * @param {string} cwd
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{ root: string, commonDir: string, gitDir: string, isMain: boolean }}
 */
export function repoInfo(cwd, { env } = {}) {
  if (env) return readRepoInfo(cwd, env);
  const key = `repoInfo:${resolve(cwd)}`;
  if (gitReadFacts.getStore() === true) {
    return readFact(key, () => repositorySignature(cwd), () => readRepoInfo(cwd));
  }
  return fact(key, () => readRepoInfo(cwd));
}

/**
 * Read top level, worktree Git dir and shared Git dir in one process. With no inherited selector, the same process
 * also reads this checkout's HEAD commit and the primary checkout's branch and commit, and keeps them as this
 * command's headCommit, mainCheckout and effective hook-path facts, preserving Git's own configuration resolution.
 *
 * @param {string} cwd
 * @returns {{ root: string, commonDir: string, gitDir: string, isMain: boolean }}
 */
function readRepoInfo(cwd, env) {
  const combined = !env && gitFacts.getStore()?.active && plainRepositoryEnvironment();
  const resumeSources = combined && gitFacts.getStore().resumeSources;
  const optional = ['main-worktree/HEAD:pullboard.json', 'main-worktree/HEAD:DOCTRINE.md'];
  const primary = combined ? ['HEAD^{commit}', 'main-worktree/HEAD^{commit}', '--git-path', 'hooks',
    ...(resumeSources ? optional : []), '--symbolic-full-name', 'main-worktree/HEAD'] : [];
  const info = tryGit(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', ...primary], { env });
  const fields = info.stdout.split('\n');
  /** Recognize full SHA-1 or SHA-256 object identities before accepting a partial optional response. */
  const oid = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value ?? '');
  const baseValid = fields.length >= 6 && fields.slice(0, 3).every(isAbsolute)
    && oid(fields[3]) && oid(fields[4]) && isAbsolute(fields[5]);
  const missingOptional = resumeSources && info.status !== 0 && (fields.length === 7 && fields[6] === optional[0]
    || fields.length === 8 && oid(fields[6]) && fields[7] === optional[1]);
  if (combined && info.stdout && (!baseValid || info.status !== 0 && !missingOptional)) return readRepoInfo(cwd, process.env);
  if (combined && baseValid) {
    const [root, , , head, commit, hooks] = fields;
    const [config, doctrine] = resumeSources ? fields.slice(6, 8) : [];
    const branch = fields[resumeSources ? 8 : 6];
    const suffixValid = missingOptional || (resumeSources
      ? (fields.length === 8 || fields.length === 9) && oid(config) && oid(doctrine)
      : fields.length === 6 || fields.length === 7) && (branch === undefined || branch.startsWith('refs/'));
    if (!suffixValid) return readRepoInfo(cwd, process.env);
    const { facts } = gitFacts.getStore();
    facts.set(`gitPath:${JSON.stringify([resolve(root), 'hooks'])}`, resolve(root, hooks));
    facts.set(`headCommit:${resolve(root)}`, head);
    if (!missingOptional) facts.set(`mainCheckout:${resolve(root)}`, branch?.startsWith('refs/') ? { branch, commit } : null);
    if (oid(config) && oid(doctrine)) facts.set(`mainSourceBlobs:${resolve(root)}`, { commit, config, doctrine });
    fields.length = 3;
  }
  if (info.status !== 0 && !missingOptional || fields.length !== 3 || fields.some((field) => !field)) {
    const bare = bareWorktreeFinding(cwd);
    if (bare) throw new Refused(bare.code, `${bare.message}; run ${bare.next}`);
    throw new Refused('NOT_A_REPO', 'not inside a git work tree; run git init, or cd into a repo');
  }
  const [root, gitDir, commonDir] = fields;
  return { root, commonDir, gitDir, isMain: realpathSync.native(commonDir) === realpathSync.native(gitDir) };
}

/** Determine code provenance without letting a caller's active hook redirect Git's repository.
 *
 * @param {string} [root]
 * @returns {boolean}
 */
export function codeIsFromMain(root = CODE_ROOT) {
  const key = `codeIsFromMain:${resolve(root)}`;
  if (gitReadFacts.getStore() === true) {
    return readFact(key, () => repositorySignature(root), () => readCodeIsFromMain(root));
  }
  return fact(key, () => readCodeIsFromMain(root));
}

/** Identify the running source's repository without letting an inherited hook redirect Git. */
export function codeUsesRepository(commonDir, root = CODE_ROOT) {
  const info = tryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { env: gitChildEnv(root) });
  return info.status === 0 && realpathSync.native(info.stdout.trim()) === realpathSync.native(commonDir);
}

/** Determine whether the code is from its main checkout, retaining the non-repository fallback. */
function readCodeIsFromMain(root) {
  // The same variables `git rev-parse --local-env-vars` names, cleared without a Git process to ask.
  const env = cleanGitEnvironment();
  const info = tryGit(root, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], { env });
  const fields = info.stdout.split('\n');
  if (info.status === 0 && fields.length === 3 && fields.every(Boolean)) {
    return realpathSync.native(fields[2]) === realpathSync.native(fields[1]);
  }
  if (info.status === 0) return repoInfo(root, { env }).isMain;
  let folder = resolve(root);
  while (true) {
    try {
      lstatSync(join(folder, '.git'));
      throw new Refused('UNMERGED_SCHEMA', 'the running code has Git metadata that cannot be read; restore its Git link before retrying, or install a released pullboard outside this checkout');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(folder);
    if (parent === folder) return true;
    folder = parent;
  }
}

/**
 * Whether the config file `git config --local` reads holds exactly one plain `<section>.<key>`, and it is `value`.
 * False whenever the file could mean anything less certain (an include, a continued line, a quoted or commented
 * value, a repeated key, an inherited selector), so the caller asks Git as before.
 *
 * @param {string} root
 * @param {string} section
 * @param {string} key
 * @param {string} value
 * @returns {boolean}
 */
export function localConfigIs(root, section, key, value) {
  if (!/^[\w./-]+$/u.test(value) || !plainRepositoryEnvironment()) return false;
  let text;
  try { text = readFileSync(join(repoInfo(root).commonDir, 'config'), 'utf8'); }
  catch { return false; }
  if (/^\s*\[\s*include/imu.test(text) || /\\\r?$/mu.test(text)) return false;
  let inSection = false;
  const values = [];
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]*)\]\s*$/u.exec(line);
    if (header) inSection = header[1].trim().toLowerCase() === section;
    else if (/^\s*\[/u.test(line)) return false;
    else {
      const entry = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*?))?\s*$/u.exec(line);
      if (inSection && entry?.[1].toLowerCase() === key) values.push(entry[2]);
    }
  }
  return values.length === 1 && values[0] === value;
}

/**
 * The full id of a commit-ish, or null when it names no commit here.
 *
 * @param {string} root
 * @param {string} ref
 * @returns {string | null}
 */
export function resolveCommit(root, ref) {
  if (ref === 'HEAD') return headCommit(root);
  return fact(`resolveCommit:${resolve(root)}:${ref}`, () => {
    const result = tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return result.status === 0 ? result.stdout : null;
  });
}

/**
 * The commit HEAD points at, or null in a repo with no commits yet.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function headCommit(root) {
  const key = `headCommit:${resolve(root)}`;
  const read = () => {
    const result = tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    return result.status === 0 ? result.stdout : null;
  };
  if (gitReadFacts.getStore() === true) {
    return readFact(key, () => repositorySignature(root, null, true), read);
  }
  return fact(key, read);
}

/**
 * The tree HEAD holds, or null with no commits.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function headTree(root) {
  const key = `headTree:${resolve(root)}`;
  const read = () => {
    const result = tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}']);
    return result.status === 0 ? result.stdout : null;
  };
  if (gitReadFacts.getStore() === true) {
    return readFact(key, () => repositorySignature(root, null, true), read);
  }
  return fact(key, read);
}

/**
 * True when no tracked file differs from HEAD, staged or not.
 *
 * @param {string} root
 * @returns {boolean}
 */
export function isClean(root) {
  return git(root, ['status', '--porcelain', '--untracked-files=no']) === '';
}

/**
 * How each file under `paths` in the work tree differs from HEAD, whatever is staged: not
 * committed, changed or deleted. A file git ignores counts too, marked, since no commit holds it.
 * With no commits yet, every file there is not committed. Read-only: git takes no index lock.
 *
 * @param {string} root
 * @param {string[]} paths
 * @returns {{ path: string, how: string, ignored: boolean }[]}
 */
export function differFromHead(root, paths) {
  const listed = (args) =>
    execFileSync('git', ['--no-optional-locks', ...GIT_FLAGS, ...args], { cwd: root, encoding: 'utf8', input: '' }).split('\0').filter(Boolean);
  const base = headCommit(root) ?? listed(['hash-object', '-t', 'tree', '--stdin'])[0].trim();
  const fields = listed(['diff', '--no-renames', '--name-status', '-z', base, '--', ...paths]);
  const found = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    found.push({ path: fields[i + 1], how: { A: 'not committed', D: 'deleted' }[fields[i]] ?? 'changed', ignored: false });
  }
  for (const path of listed(['ls-files', '-z', '--others', '--exclude-standard', '--', ...paths])) {
    found.push({ path, how: 'not committed', ignored: false });
  }
  for (const path of listed(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...paths])) {
    found.push({ path, how: 'not committed; git ignores it', ignored: true });
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Files git would show as untracked: new, and not ignored.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function untracked(root) {
  const out = git(root, ['ls-files', '--others', '--exclude-standard']);
  return out ? out.split('\n') : [];
}

/**
 * True when `ancestor` is `descendant` or in its history.
 *
 * @param {string} root
 * @param {string} ancestor
 * @param {string} descendant
 * @returns {boolean}
 */
export function contains(root, ancestor, descendant) {
  return tryGit(root, ['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
}

/**
 * A path inside this worktree's git dir, for state that must never sit in the tree.
 *
 * @param {string} root
 * @param {string} name
 * @returns {string}
 */
export function gitPath(root, name) {
  return fact(`gitPath:${JSON.stringify([resolve(root), name])}`,
    () => resolve(root, git(root, ['rev-parse', '--git-path', name])));
}

/** Refuse lane-sensitive history checks while grafts can rewrite commit ancestry despite replacement guards [L3]. */
export function refuseGrafts(root) {
  const file = gitPath(root, 'info/grafts');
  if (existsSync(file)) throw new Refused('GIT_GRAFTS', `lane checks cannot trust history while ${file} exists; ask the coordinator to remove the graft file before retrying`);
}
