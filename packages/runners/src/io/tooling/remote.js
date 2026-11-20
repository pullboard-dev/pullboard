import { archivedToolingSource } from './committed.js';
import { committedRunnerController } from './committed.js';
import { committedToolingKey } from './committed.js';
import { runnerPackage } from '../package.js';
/** Pin, scan and install the trusted runner tooling bytes a remote worker runs [C7]. */
import { runnerSource } from '../../../../gate/light.js';
import { removeGitRepositorySelectors } from '../../../../git/index.js';
import { secretsIn } from '../../../../commits/index.js';
import { Refused } from '../../../../kernel/index.js';
import { installRunnerPackage } from '../package/install.js';
import { REUSE_CAPSULE } from '../runtime.js';
import { MAX_BLOB_BYTES } from '../source/scan.js';
import { sourceGit } from '../source/scan.js';
import { captureRunnerTooling } from './snapshot.js';
import { loadToolingBundle } from './bundle.js';
import { saveToolingBundle } from './bundle.js';
import { loadTrustedCapture } from './saved.js';
import { saveTrustedCapture } from './saved.js';
import { currentRunnerTooling } from './snapshot.js';
import { claimRunnerLaunch } from '../transport.js';
import { recoveryIdentity } from '../../../../resources/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readSync } from 'node:fs';
import { join } from 'node:path';
import { environmentAdapter } from '../../../../env/index.js';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const TOOL_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

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
  const inherited = environmentAdapter().all();
  removeGitRepositorySelectors(inherited, process.stderr.write.bind(process.stderr));
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'TMPDIR', 'SystemRoot', 'WINDIR']) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  return { ...env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

/**
 * Guard the full pinned controller policy graph before dispatching a fresh controller.
 * This tracked step changes with the new pin, fencing generations loaded before graph fingerprinting existed.
 */
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

/** What the last committed capture of each controller root gave, with the commit and tree it was taken at. */
const CAPTURED = new Map();

/**
 * Snapshot, scan and pin the actual tooling bytes independently of the project being tested.
 * Why cached: a committed export, its file closure, scan and blob comparison are a function of the tree alone, and each
 * submit spent 3.4-4.5 s repeating them (#8133). A changed commit or tree captures afresh; a root with no committed
 * export (an installed package, or a generation pin) is captured every time, as it can change under the process.
 */
export function trustedTooling() {
  const id = committedToolingKey(TOOL_ROOT);
  const held = id && CAPTURED.get(TOOL_ROOT);
  if (held && held.commit === id.commit && held.tree === id.tree) return held.captured;
  const saved = id && loadTrustedCapture(TOOL_ROOT, id);
  if (saved) { CAPTURED.set(TOOL_ROOT, { commit: id.commit, tree: id.tree, captured: saved }); return saved; }
  const { captured, installation, order, bundled } = (id && bundledTooling(id)) ?? captureTrustedTooling();
  const key = installation ?? (captured.tooling.commit && { commit: captured.tooling.commit, tree: captured.tooling.tree });
  if (key) {
    CAPTURED.set(TOOL_ROOT, { commit: key.commit, tree: key.tree, captured });
    saveTrustedCapture(TOOL_ROOT, key, captured, order);
    if (!bundled) saveToolingBundle(TOOL_ROOT, captured, order);
  }
  return captured;
}

/**
 * The bundle of this root's last tooling digest, when every file in it is the same blob at the new commit (#8462).
 * Why: each landing moves main, and a commit-keyed capture rebuilt the unchanged worker closure on every trip.
 */
function bundledTooling(id) {
  const gitRoot = existsSync(join(TOOL_ROOT, '.git')) ? TOOL_ROOT : archivedToolingSource(TOOL_ROOT)?.root;
  const found = gitRoot && loadToolingBundle(TOOL_ROOT, id, gitRoot, committedToolingMatches);
  return found ? { ...found, installation: id, bundled: true } : null;
}

/** Export, scan and describe the trusted tooling once; the installation it came from, if committed, rides along for its key. */
function captureTrustedTooling() {
  const installation = committedRunnerController(TOOL_ROOT, { shared: true });
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
  return { order: Object.keys(files), installation: installation && { commit: installation.commit, tree: installation.tree }, captured: { worker: files[entry], tooling,
    runtime: { entry, files: runtimeFiles, sha256: createHash('sha256').update(JSON.stringify(runtimeFiles)).digest('hex') } } };
  } finally { installation?.cleanup(); }
}

/** The largest capsule a remote installer reads from stdin; the installer's own gunzip bound is 8 MiB. */
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

/** claimRunnerLaunch reads through the fs adapter, which the generated installer cannot import; it gets the same synchronous calls under that name [C7]. */
const RECOVERY_FS_SHIM = 'const fs = { mkdir: mkdirSync, writeFile: writeFileSync };\n';

/**
 * Install pinned bytes first, then replace the SSH shell with the file-based worker.
 * The command stays small and fixed; the capsule goes first on stdin, ahead of anything the worker reads.
 *
 * @returns {{ command: string, input: Buffer }} The remote command and the stdin bytes to write before any other.
 */
export function remoteWorkerLaunch(runner, worker, tooling, runtime, extra = '', recovery = null, { reuse = false } = {}) {
  const files = Object.fromEntries(Object.entries({ ...runtime.files, [runtime.entry]: worker }).sort(([a], [b]) => a.localeCompare(b)));
  // The transfer bound protects what crosses the wire, the gzipped capsule; the raw bundle is ratcheted on main (#4140).
  const full = gzipSync(Buffer.from(JSON.stringify(files))).toString('base64');
  if (Buffer.byteLength(full) > CAPSULE_STDIN_LIMIT) throw new Refused('RUNNER_REQUEST_LIMIT', 'runner tooling capsule exceeds its safe transfer limit; keep this run local');
  // A runner that holds this runtime by digest gets an empty capsule and re-hashes its installed copy.
  const payload = reuse ? REUSE_CAPSULE : full;
  if (Buffer.byteLength(payload) > CAPSULE_STDIN_LIMIT) throw new Refused('RUNNER_REQUEST_LIMIT', 'runner tooling capsule exceeds its safe transfer limit; keep this run local');
  const installer = `import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
${installRunnerPackage.toString()}
${readCapsuleFromStdin.toString()}
installRunnerPackage(readCapsuleFromStdin(), ${JSON.stringify(tooling.sha256)}, ${JSON.stringify(runner.root ?? '')});
${recovery ? RECOVERY_FS_SHIM + recoveryIdentity.toString() + '\n' + claimRunnerLaunch.toString() + '\nif (!claimRunnerLaunch(' + JSON.stringify(runner.root ?? '') + " || join(homedir(), '.pullboard-runner')," + JSON.stringify(recovery) + ")) throw new Error('PULLBOARD_RUNNER_LAUNCH_FENCED');" : ''}`;
  const node = shellWord(runner.node ?? 'node');
  const suffix = `/runtime/${tooling.sha256}/${tooling.entry ?? 'apps/runner/src/io/scripts/worker.js'}`;
  const entry = runner.root ? shellWord(runner.root + suffix) : `"$HOME"${shellWord('/.pullboard-runner' + suffix)}`;
  return { command: `${node} --input-type=module -e ${shellWord(installer)} && exec ${node} ${entry}${extra}`,
    input: Buffer.from(`${Buffer.byteLength(payload)}\n${payload}`, 'ascii') };
}
