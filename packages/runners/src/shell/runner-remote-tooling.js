import { archivedToolingSource } from './committed-tooling.js';
import { committedRunnerController } from './committed-tooling.js';
import { runnerPackage } from './runner-package.js';
/** Pin, scan and install the trusted runner tooling bytes a remote worker runs [C7]. */
import { runnerSource } from '../../../gate/src/core/gate-policy-load.js';
import { removeGitRepositorySelectors } from '../../../git/index.js';
import { secretsIn } from '../../../commits/index.js';
import { Refused } from '../../../kernel/index.js';
import { installRunnerPackage } from './runner-package-install.js';
import { MAX_BLOB_BYTES } from './runner-source-scan.js';
import { sourceGit } from './runner-source-scan.js';
import { captureRunnerTooling } from './runner-tooling-snapshot.js';
import { currentRunnerTooling } from './runner-tooling-snapshot.js';
import { claimRunnerLaunch } from './runner-transport.js';
import { recoveryIdentity } from '../../../resources/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const TOOL_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// The generation of the runners.js instance whose operation is running; the first pin answers callers outside one.
const GENERATION = new AsyncLocalStorage();
let LOADED_TOOLING = null;
// When this module loaded: bytes written after it do not belong to this controller, even though the capture waits for first use.
const LOAD_INSTANT = Date.now();

/** Whether any runners.js instance has pinned the loaded tooling in this process. */
export function runnerToolingPinned() { return LOADED_TOOLING !== null; }

/**
 * Pin one runners.js instance's controller generation when it loads; the closure capture waits for first use.
 * Why: parsing the package at import cost every command ~0.8 s; the load instant still bounds which bytes count.
 */
export function pinRunnerTooling(since = LOAD_INSTANT) {
  let loaded;
  const generation = { get loaded() { return loaded === undefined ? (loaded = loadedTooling(since)) : loaded; } };
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

/** Capture the derived runtime and controller generation once, refusing bytes written after the instance loaded. */
function loadedTooling(since) {
  try { return captureRunnerTooling(TOOL_ROOT, { since }); }
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
  const installation = committedRunnerController(TOOL_ROOT);
  try {
  const root = installation?.root ?? TOOL_ROOT;
  const { entry, files } = installation ? runnerPackage(root) : loadedToolingFiles();
  for (const [name, source] of Object.entries(files)) {
    if (Buffer.byteLength(source) > MAX_BLOB_BYTES
      || secretsIn(source.split(/\r?\n/u).map((text, index) => ({ path: `tooling/${name}`, line: index + 1, text }))).length) {
      throw new Refused('RUNNER_TOOLING_SECRET', 'the selected runner tooling failed its transfer scan; restore a trusted Pullboard installation');
    }
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'pullboard' || typeof manifest.version !== 'string') {
    throw new Refused('RUNNER_TOOLING_IDENTITY', 'runner tooling must come from a named Pullboard installation; reinstall Pullboard');
  }
  let provenance = { kind: 'installed-package', name: manifest.name, version: manifest.version };
  const archived = archivedToolingSource(root);
  if (archived || existsSync(join(root, '.git'))) {
    const selected = archived ?? runnerSource(root);
    if (!selected || !committedToolingMatches(archived?.root ?? root, selected.commit, files)) {
      throw new Refused('RUNNER_TOOLING_CHANGED', 'runner tooling differs from its selected committed revision; restore or commit the tooling before remote execution');
    }
    provenance = { ...provenance, kind: 'git-checkout', commit: selected.commit, tree: selected.tree };
  }
  const tooling = { ...provenance, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
  const runtimeFiles = Object.fromEntries(Object.entries(files).filter(([name]) => name !== entry));
  return { worker: files[entry], tooling,
    runtime: { entry, files: runtimeFiles, sha256: createHash('sha256').update(JSON.stringify(runtimeFiles)).digest('hex') } };
  } finally { installation?.cleanup(); }
}

/** The largest capsule a remote installer reads from stdin; the installer's own gunzip bound stays 1 MiB. */
export const CAPSULE_STDIN_LIMIT = 4 * 1024 ** 2;

/**
 * Read one length-prefixed capsule from the job's stdin, byte-exact, so the exec'd worker reads the rest.
 * Why: the capsule rode in the SSH exec command, and OpenSSH resets any command over its 256 KiB packet bound.
 */
export function readCapsuleFromStdin() {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const read = (buffer, offset, length) => {
    for (;;) {
      try { return readSync(0, buffer, offset, length, null); }
      catch (error) { if (error.code !== 'EAGAIN') throw error; Atomics.wait(pause, 0, 0, 5); }
    }
  };
  const one = Buffer.alloc(1);
  let header = '';
  for (;;) {
    if (read(one, 0, 1) !== 1) throw new Error('runner capsule ended before its length');
    if (one[0] === 10) break;
    header += String.fromCharCode(one[0]);
    if (!/^[0-9]{1,8}$/u.test(header)) throw new Error('invalid runner capsule length');
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length < 1 || length > 4 * 1024 ** 2) throw new Error('invalid runner capsule length');
  const bytes = Buffer.alloc(length);
  let received = 0;
  while (received < length) {
    const count = read(bytes, received, length - received);
    if (count === 0) throw new Error('runner capsule ended early');
    received += count;
  }
  return bytes.toString('ascii');
}

/**
 * Install pinned bytes first, then replace the SSH shell with the file-based worker.
 * The command stays small and fixed; the capsule goes first on stdin, ahead of anything the worker reads.
 *
 * @returns {{ command: string, input: Buffer }} The remote command and the stdin bytes to write before any other.
 */
export function remoteWorkerLaunch(runner, worker, tooling, runtime, extra = '', recovery = null) {
  const files = Object.fromEntries(Object.entries({ ...runtime.files, [runtime.entry]: worker }).sort(([a], [b]) => a.localeCompare(b)));
  const payload = gzipSync(Buffer.from(JSON.stringify(files))).toString('base64');
  if (Buffer.byteLength(payload) > CAPSULE_STDIN_LIMIT) throw new Refused('RUNNER_REQUEST_LIMIT', 'runner tooling capsule exceeds its safe transfer limit; keep this run local');
  const installer = `import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
${installRunnerPackage.toString()}
${readCapsuleFromStdin.toString()}
installRunnerPackage(readCapsuleFromStdin(), ${JSON.stringify(tooling.sha256)}, ${JSON.stringify(runner.root ?? '')});
${recovery ? recoveryIdentity.toString() + '\n' + claimRunnerLaunch.toString() + '\nif (!claimRunnerLaunch(' + JSON.stringify(runner.root ?? '') + " || join(process.env.HOME, '.pullboard-runner')," + JSON.stringify(recovery) + ")) throw new Error('PULLBOARD_RUNNER_LAUNCH_FENCED');" : ''}`;
  const node = shellWord(runner.node ?? 'node');
  const suffix = `/runtime/${tooling.sha256}/src/runner-worker.js`;
  const entry = runner.root ? shellWord(runner.root + suffix) : `"$HOME"${shellWord('/.pullboard-runner' + suffix)}`;
  return { command: `${node} --input-type=module -e ${shellWord(installer)} && exec ${node} ${entry}${extra}`,
    input: Buffer.from(`${Buffer.byteLength(payload)}\n${payload}`, 'ascii') };
}
