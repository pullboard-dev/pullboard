/** Pin, scan and install the trusted runner tooling bytes a remote worker runs [C7]. */
import { runnerSource } from './gate-policy-load.js';
import { removeGitRepositorySelectors } from './git-child-selectors.js';
import { secretsIn } from './hooks.js';
import { Refused } from './refused.js';
import { installRunnerPackage } from './runner-package-install.js';
import { MAX_BLOB_BYTES } from './runner-source-scan.js';
import { sourceGit } from './runner-source-scan.js';
import { captureRunnerTooling } from './runner-tooling-snapshot.js';
import { currentRunnerTooling } from './runner-tooling-snapshot.js';
import { claimRunnerLaunch } from './runner-transport.js';
import { recoveryIdentity } from './runner-transport.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const TOOL_ROOT = fileURLToPath(new URL('../', import.meta.url));

// The generation of the runners.js instance whose operation is running; the first pin answers callers outside one.
const GENERATION = new AsyncLocalStorage();
let LOADED_TOOLING = null;

/** Pin one runners.js instance's controller generation when it loads, before any later dispatch. */
export function pinRunnerTooling() {
  const generation = { loaded: loadedTooling() };
  LOADED_TOOLING ??= generation;
  return generation;
}

/**
 * Run one front-door operation against the generation its own runners.js instance pinned.
 * Why: a shared step module must not let a newer instance's pin vouch for an older instance's stale bytes.
 */
export function inRunnerGeneration(generation, operation) {
  return GENERATION.run(generation, operation);
}

/** Pin the actual derived runtime and controller generation before any later dispatch. */
function loadedTooling() {
  try { return captureRunnerTooling(TOOL_ROOT); }
  catch (problem) { return problem?.code === 'RUNNER_TOOLING_FILES' ? { problem } : null; }
}

/** Quote one remote shell argument without permitting substitutions or expansion. */
export function shellWord(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/** Give the SSH client connection necessities only; arbitrary caller secrets cannot be forwarded. */
export function sshEnvironment() {
  const inherited = { ...process.env };
  removeGitRepositorySelectors(inherited, process.stderr.write.bind(process.stderr));
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'TMPDIR', 'SystemRoot', 'WINDIR']) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  return { ...env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

/** Share the loaded generation guard; async callers leave the closure scan to their fresh controller. */
export function loadedToolingFiles({ rescan = true } = {}) {
  return currentRunnerTooling(TOOL_ROOT, (GENERATION.getStore() ?? LOADED_TOOLING)?.loaded ?? null, { rescan });
}

/** Compare every shipped runtime byte with its immutable Git blob, using bounded literal path batches. */
function committedToolingMatches(root, commit, files) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) return false;
  const names = Object.keys(files), objects = new Map();
  let offset = 0;
  while (offset < names.length) {
    const batch = [];
    let bytes = 0;
    while (offset < names.length) {
      const size = Buffer.byteLength(names[offset]) + 1;
      if (size > 32_768) return false;
      if (bytes + size > 32_768) break;
      batch.push(names[offset++]);
      bytes += size;
    }
    const wanted = new Set(batch);
    const records = sourceGit(root, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', commit, '--', ...batch]);
    if (records && !records.endsWith('\0')) return false;
    for (const record of records.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t'), name = record.slice(tab + 1);
      const fields = /^(?:100644|100755) blob ([a-f0-9]+)$/u.exec(record.slice(0, tab));
      if (tab < 0 || !fields || fields[1].length !== commit.length || !wanted.has(name) || objects.has(name)) return false;
      objects.set(name, fields[1]);
    }
  }
  return objects.size === names.length && names.every(name => {
    const body = Buffer.from(files[name], 'utf8');
    const object = createHash(commit.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${body.length}\0`).update(body).digest('hex');
    return objects.get(name) === object;
  });
}

/** Snapshot, scan and pin the actual tooling bytes independently of the project being tested. */
export function trustedTooling() {
  const { entry, files } = loadedToolingFiles();
  for (const [name, source] of Object.entries(files)) {
    if (Buffer.byteLength(source) > MAX_BLOB_BYTES
      || secretsIn(source.split(/\r?\n/u).map((text, index) => ({ path: `tooling/${name}`, line: index + 1, text }))).length) {
      throw new Refused('RUNNER_TOOLING_SECRET', 'the selected runner tooling failed its transfer scan; restore a trusted Pullboard installation');
    }
  }
  const manifest = JSON.parse(readFileSync(join(TOOL_ROOT, 'package.json'), 'utf8'));
  if (manifest.name !== 'pullboard' || typeof manifest.version !== 'string') {
    throw new Refused('RUNNER_TOOLING_IDENTITY', 'runner tooling must come from a named Pullboard installation; reinstall Pullboard');
  }
  let provenance = { kind: 'installed-package', name: manifest.name, version: manifest.version };
  if (existsSync(join(TOOL_ROOT, '.git'))) {
    const selected = runnerSource(TOOL_ROOT);
    if (!selected || !committedToolingMatches(TOOL_ROOT, selected.commit, files)) {
      throw new Refused('RUNNER_TOOLING_CHANGED', 'runner tooling differs from its selected committed revision; restore or commit the tooling before remote execution');
    }
    provenance = { ...provenance, kind: 'git-checkout', ...selected };
  }
  const tooling = { ...provenance, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
  const runtimeFiles = Object.fromEntries(Object.entries(files).filter(([name]) => name !== entry));
  return { worker: files[entry], tooling,
    runtime: { entry, files: runtimeFiles, sha256: createHash('sha256').update(JSON.stringify(runtimeFiles)).digest('hex') } };
}

/** Install pinned bytes first, then replace the SSH shell with the file-based worker. */
export function remoteWorkerCommand(runner, worker, tooling, runtime, extra = '', recovery = null) {
  const files = Object.fromEntries(Object.entries({ ...runtime.files, [runtime.entry]: worker }).sort(([a], [b]) => a.localeCompare(b)));
  const payload = gzipSync(Buffer.from(JSON.stringify(files))).toString('base64');
  const installer = `import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
${installRunnerPackage.toString()}
installRunnerPackage(${JSON.stringify(payload)}, ${JSON.stringify(tooling.sha256)}, ${JSON.stringify(runner.root ?? '')});
${recovery ? recoveryIdentity.toString() + '\n' + claimRunnerLaunch.toString() + '\nif (!claimRunnerLaunch(' + JSON.stringify(runner.root ?? '') + " || join(process.env.HOME, '.pullboard-runner')," + JSON.stringify(recovery) + ")) throw new Error('PULLBOARD_RUNNER_LAUNCH_FENCED');" : ''}`;
  const node = shellWord(runner.node ?? 'node');
  const suffix = `/runtime/${tooling.sha256}/src/runner-worker.js`;
  const entry = runner.root ? shellWord(runner.root + suffix) : `"$HOME"${shellWord('/.pullboard-runner' + suffix)}`;
  return `${node} --input-type=module -e ${shellWord(installer)} && exec ${node} ${entry}${extra}`;
}
