/** Immutable board-local tool installations; project source and the command's cwd never move. */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { randomUUID } from 'node:crypto';
// Use the public browser-safe door to keep the thin resident client from loading the full kernel.
import { Refused } from '../../../../../../packages/kernel/browser.js';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Read Git without inheriting a caller's alternate index or repository selector. */
function git(root, args, binary = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const result = spawnSync('git', ['--no-replace-objects', ...args], { cwd: root, env,
    encoding: binary ? undefined : 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Refused('TOOL_BUILD_UNAVAILABLE', 'restore the published tool build Git objects, or ask the coordinator to promote a gated build');
  return binary ? result.stdout : result.stdout.trim();
}

/** Locate shared storage before loading any live-trunk configuration parser. */
export function toolBuildLocation(cwd) {
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
  try { raw = JSON.parse(git(location.root, ['show', 'main-worktree/HEAD:pullboard.json'])); }
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
