/** Exact committed source and bounded, credential-free SSH execution for machine runners [C7]. */
export { placeRunner, runnerStage } from './runner-stage.js';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import {
  environmentProblem,
  testRuntimeRows,
} from './execution-environment.js';
import {
  gunzipSync,
  gzipSync,
} from 'node:zlib';
import {
  configFromSource,
  defaults,
} from './config.js';
import {
  blockedPaths,
  secretsIn,
} from './hooks.js';
import {
  cleanGitEnvironment,
  headCommit,
  headTree,
  isClean,
  repoInfo,
  untracked,
} from './git.js';
import { Refused } from './refused.js';
import { recordRunnerGui } from './resources.js';
import {
  privateCheckEnvelope,
  privateCheckPhases,
} from './runner-private-mode.js';
import {
  gateStages,
  readStages,
} from './gate-stages.js';
import { remoteFileDenial } from './sandbox-denial.js';
import {
  carriedBrowserByLaunch,
  readMachineSettingsFile,
} from './queue-settings.js';

// Budget: 64 MiB bounds worst-case JSON bridge escaping below Node string limits.
const MAX_OUTPUT_BYTES = 64 * 1024 ** 2;
const MAX_BLOB_BYTES = 8 * 1024 ** 2;
const MAX_HISTORY_TAGS = 1_024;
const MAX_TAG_CHAIN = 8;
const TOOL_ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUNTIME_NAMES = ['runner-custody.js', 'resources.js', 'git.js', 'machine-home.js', 'refused.js', 'process-census.js', 'queue-settings.js', 'queue-order.js', 'sandbox-denial.js', 'gate-stages.js', 'child-journal-preload.js', 'execution-environment.js', 'runner-load.js', 'gui-session.js', 'runner-private-mode.js'];

/** Validate an SSH destination as one argument, never a command or an SSH option. */
export function validateRunner(value) {
  if (!value || typeof value.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@:\[\]-]{0,254}$/u.test(value.host)
    || !Number.isSafeInteger(value.slots) || value.slots < 1
    || !Number.isSafeInteger(value.browser) || value.browser < 0 || value.browser > value.slots) {
    throw new Refused('BAD_RUNNER', 'use an SSH host or alias, positive --slots, and --browser from zero through slots');
  }
  if (value.gui !== undefined && value.gui !== null && typeof value.gui !== 'boolean') throw new Refused('BAD_RUNNER', 'runner gui must be true, false, or unknown');
  for (const key of ['node', 'root']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || /[\u0000-\u001f\u007f]/u.test(value[key])
      || !(value[key].startsWith('/') && value[key].length > 1 || key === 'node' && value[key] === 'node'))) {
      throw new Refused('BAD_RUNNER', `runner ${key} must be an absolute remote path${key === 'node' ? ' or node' : ''}`);
    }
  }
  return { host: value.host, slots: value.slots, browser: value.browser, ...(value.gui !== undefined ? { gui: value.gui } : {}),
    ...(value.node ? { node: value.node } : {}), ...(value.root ? { root: value.root } : {}) };
}

/** Dirty or non-repository commands cannot claim to execute an exact committed source remotely. */
export function runnerSource(root) {
  try {
    if (!isClean(root) || untracked(root).length) return null;
    return { commit: headCommit(root), tree: headTree(root) };
  } catch { return null; }
}

/** A missing authenticated completion receipt is a transport loss, never a passing test result. */
export class RunnerDropped extends Error {
  constructor(host) {
    super(`runner ${host} disconnected before a complete result; the run returns to the queue`);
    this.name = 'RunnerDropped';
    this.host = host;
  }
}

/** Run a source-only Git read without inherited Git configuration, hooks or replacement objects. */
function sourceGit(root, args, options = {}) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: MAX_BLOB_BYTES, ...options,
  });
  if (result.status !== 0) throw new Refused('RUNNER_SOURCE', 'cannot read the exact committed source; check Git and retry the run');
  return result.stdout;
}

/** Scan every current blob and the commit message before any source bytes leave the controller. */
function sourceObjects(root, source) {
  const records = sourceGit(root, ['ls-tree', '-r', '-z', '--full-tree', source.commit]).split('\0').filter(Boolean);
  // Protection is pinned to the admitted commit, never a concurrently edited working file.
  const configRecord = records.find(record => record.endsWith('\tpullboard.json'));
  const configObject = configRecord?.match(/^\d+ blob ([a-f0-9]{40,64})\t/u)?.[1];
  const config = configObject ? configFromSource(sourceGit(root, ['cat-file', 'blob', configObject])) : defaults();
  const protect = source.protect ?? config.protect;
  const blobs = records.map(record => {
    const match = /^(\d+) (\w+) ([a-f0-9]{40,64})\t([\s\S]+)$/u.exec(record);
    if (!match || match[2] !== 'blob') throw new Refused('RUNNER_SOURCE', 'runner source contains a submodule or unsupported object; keep this run local');
    const [, , , object, path] = match;
    if (blockedPaths([path], protect).length || /(?:^|\/)board\.sqlite(?:-(?:wal|shm))?$/u.test(path)) {
      throw new Refused('RUNNER_SECRET', 'committed runner source includes a blocked private file; remove it before remote execution');
    }
    return { object, path };
  });
  // Hundreds of per-blob Git launches used almost the entire dispatch budget under load.
  // Check every size first, then stream the same pinned bodies through one bounded record reader.
  if (blobs.length) {
    const input = blobs.map(({ object }) => object + '\n').join('');
    const metadata = sourceGit(root, ['cat-file', '--batch-check'], { input }).trimEnd().split('\n');
    if (metadata.length !== blobs.length) throw new Refused('RUNNER_SOURCE', 'incomplete current source inventory; retry from the committed repository');
    const sizes = metadata.map((line, index) => {
      const match = /^([a-f0-9]{40,64}) blob (\d+)$/u.exec(line);
      if (!match || match[1] !== blobs[index].object) throw new Refused('RUNNER_SOURCE', 'invalid current source inventory; retry from the committed repository');
      const size = Number(match[2]);
      if (!Number.isSafeInteger(size) || size > MAX_BLOB_BYTES) {
        throw new Refused('RUNNER_SCAN_LIMIT', 'a committed blob exceeds the safe runner scan limit; keep the run local or reduce that file');
      }
      return size;
    });
    const scratch = mkdtempSync(join(tmpdir(), 'pullboard-runner-source-'));
    try {
      const scan = join(scratch, 'current.scan');
      for (let start = 0; start < blobs.length;) {
        let end = start, bytes = 0;
        // Bound scratch usage too: an otherwise valid large tree must not fill the temp volume.
        do {
          bytes += sizes[end] + blobs[end].object.length + 32;
          end++;
        } while (end < blobs.length && bytes + sizes[end] + blobs[end].object.length + 32 <= MAX_BLOB_BYTES);
        const output = openSync(scan, 'wx', 0o600);
        try { sourceGit(root, ['cat-file', '--batch'], {
          input: blobs.slice(start, end).map(({ object }) => object + '\n').join(''), stdio: ['pipe', output, 'pipe'],
        }); } finally { closeSync(output); }
        const descriptor = openSync(scan, 'r');
        try {
          for (let index = start; index < end; index++) {
            const { object, path } = blobs[index];
            const record = objectRecord(descriptor);
            if (record.object !== object || record.type !== 'blob' || record.data.length !== sizes[index]) {
              throw new Refused('RUNNER_SOURCE', 'current source record differs from its inventory; retry from the committed repository');
            }
            const findings = secretsIn(record.data.toString('utf8').split(/\r?\n/u)
              .map((text, line) => ({ path, line: line + 1, text })));
            if (findings.length) throw new Refused('RUNNER_SECRET', `source leak scan refused ${findings[0]}; remove the secret before remote execution`);
          }
          if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) {
            throw new Refused('RUNNER_SOURCE', 'unexpected current source records; retry from the committed repository');
          }
        } finally { closeSync(descriptor); rmSync(scan, { force: true }); }
        start = end;
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  const commit = sourceGit(root, ['cat-file', 'commit', source.commit]);
  if (secretsIn(commit.split('\n').map((text, index) => ({ path: 'commit', line: index + 1, text }))).length) {
    throw new Refused('RUNNER_SECRET', 'the commit metadata contains a possible secret; keep this run local and correct the metadata');
  }
  return protect;
}

/** Reject blocked historical paths as well as current ones before an object pack crosses SSH. */
function protectedHistoryPath(path, protect) {
  return blockedPaths([path], protect).length || /(?:^|\/)board\.sqlite(?:-(?:wal|shm))?$/u.test(path);
}

/** Apply current protection rules to all selected historical names before any anonymous cache seed. */
function protectHistory(root, source, protect) {
  const paths = [...new Set(sourceGit(root, ['log', '--format=', '--name-only', '-z', '--no-renames', '--root', '-m', '--full-history', source.commit])
    .split('\0').filter(Boolean))];
  if (paths.some(path => protectedHistoryPath(path, protect))) {
    throw new Refused('RUNNER_SECRET', 'selected history includes a blocked private path; keep this run local or remove that private history');
  }
}

/** Select a locally known published ancestor, never an anonymous origin's unchecked latest tip. */
function originAncestor(root, source) {
  const tip = sourceGit(root, ['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin']).split('\n')
    .find(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value));
  if (!tip) return undefined;
  const result = spawnSync('git', ['--no-replace-objects', 'merge-base', source.commit, tip], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 4096,
  });
  const base = result.stdout?.trim();
  return result.status === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(base) ? base : undefined;
}

/** Select safe tags that point to commits in the exact candidate ancestry. */
function candidateTags(root, source) {
  const rows = sourceGit(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)', 'refs/tags'])
    .split('\n').filter(Boolean);
  if (rows.length > MAX_HISTORY_TAGS) throw new Refused('RUNNER_SCAN_LIMIT', 'too many local tags to transfer safely; keep this run local');
  const selected = [];
  // Budget: annotation scanning shares the 8 MiB object ceiling across all selected tag visits.
  let annotationBytes = 0;
  for (const row of rows) {
    const fields = row.split('\0');
    if (fields.length !== 3) throw new Refused('RUNNER_SOURCE', 'cannot read local tag refs safely; keep this run local');
    const [name, object, declaredType] = fields;
    if (!name.startsWith('refs/tags/') || name.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(name)
      || !/^[a-f0-9]{40,64}$/u.test(object) || object.length !== source.commit.length) {
      throw new Refused('RUNNER_SECRET', 'a local tag ref failed the safe transfer check; keep this run local');
    }
    sourceGit(root, ['check-ref-format', name]);
    let type = sourceGit(root, ['cat-file', '-t', object]).trim();
    if (type !== declaredType) throw new Refused('RUNNER_SOURCE', 'a local tag ref changed while preparing the run; retry');
    const peeledCommit = sourceGit(root, ['rev-parse', `${name}^{}`]).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(peeledCommit) || peeledCommit.length !== source.commit.length
      || sourceGit(root, ['cat-file', '-t', peeledCommit]).trim() !== 'commit') continue;
    const ancestor = spawnSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', 'merge-base', '--is-ancestor', peeledCommit, source.commit], {
      cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 4096,
    });
    if (ancestor.status === 1) continue;
    if (ancestor.status !== 0) throw new Refused('RUNNER_SOURCE', 'cannot validate tag ancestry; keep this run local');
    if (secretsIn([{ path: 'tag ref', line: 1, text: name }]).length) {
      throw new Refused('RUNNER_SECRET', 'a selected tag ref failed the safe transfer check; keep this run local');
    }
    const chain = [];
    if (type === 'tag') {
      let current = object;
      const seen = new Set();
      while (type === 'tag') {
        if (chain.length >= MAX_TAG_CHAIN || seen.has(current)) {
          throw new Refused('RUNNER_SCAN_LIMIT', 'an annotated tag chain exceeds the safe transfer limit; keep this run local');
        }
        seen.add(current);
        const tagBody = sourceGit(root, ['cat-file', '-p', current]);
        annotationBytes += Buffer.byteLength(tagBody);
        if (annotationBytes > MAX_BLOB_BYTES) throw new Refused('RUNNER_SCAN_LIMIT', 'a tag annotation exceeds the safe transfer limit; keep this run local');
        if (secretsIn(tagBody.split(/\r?\n/u).map((text, line) => ({ path: name, line: line + 1, text }))).length) {
          throw new Refused('RUNNER_SECRET', 'an annotated tag failed the source privacy scan; keep this run local');
        }
        const header = tagBody.split(/\r?\n\r?\n/u, 1)[0];
        const target = /^object ([a-f0-9]{40,64})$/mu.exec(header)?.[1];
        const targetType = /^type (commit|tag|tree|blob)$/mu.exec(header)?.[1];
        if (!target || target.length !== source.commit.length || !targetType
          || sourceGit(root, ['cat-file', '-t', target]).trim() !== targetType) {
          throw new Refused('RUNNER_SOURCE', 'an annotated tag has an invalid object chain; keep this run local');
        }
        chain.push(current);
        current = target;
        type = targetType;
      }
      if (type !== 'commit' || current !== peeledCommit) throw new Refused('RUNNER_SOURCE', 'an annotated tag did not peel to its declared commit');
    } else if (type !== 'commit' || object !== peeledCommit) continue;
    selected.push({ name, object, peeledCommit, chain });
  }
  return selected;
}

/** Read one exact cat-file record without loading a repository's history into memory. */
function objectRecord(descriptor) {
  const header = [];
  const byte = Buffer.alloc(1);
  while (readSync(descriptor, byte, 0, 1, null)) {
    if (byte[0] === 10) break;
    if (header.length > 200) throw new Refused('RUNNER_SOURCE', 'invalid source object header; keep this run local');
    header.push(byte[0]);
  }
  const match = /^([a-f0-9]{40,64}) (blob|tree|commit|tag) (\d+)$/u.exec(Buffer.from(header).toString('ascii'));
  if (!match) throw new Refused('RUNNER_SOURCE', 'cannot scan the selected history objects; keep this run local');
  const size = Number(match[3]);
  if (!Number.isSafeInteger(size) || size > MAX_BLOB_BYTES) throw new Refused('RUNNER_SCAN_LIMIT', 'a historical object exceeds the safe runner scan limit; keep this run local');
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(descriptor, data, offset, size - offset, null);
    if (!read) throw new Refused('RUNNER_SOURCE', 'incomplete history object; retry from the committed repository');
    offset += read;
  }
  if (readSync(descriptor, byte, 0, 1, null) !== 1 || byte[0] !== 10) throw new Refused('RUNNER_SOURCE', 'incomplete history object; retry from the committed repository');
  return { object: match[1], type: match[2], data };
}

/** Scan and pack exactly the candidate objects absent from the locked remote cache inventory. */
function historyPack(root, source, tips, directory, tags = [], knownTagObjects = []) {
  const knownTags = new Set(knownTagObjects);
  const known = sourceGit(root, ['cat-file', '--batch-check'], { input: tips.map(tip => `${tip}\n`).join('') })
    .split('\n').map(line => /^([a-f0-9]{40,64}) commit \d+$/u.exec(line)?.[1]).filter(Boolean);
  const records = sourceGit(root, ['rev-list', '--objects', source.commit, ...(source.extraCommits ?? []), '--not', ...known])
    .split('\n').filter(Boolean).map(line => {
      const match = /^([a-f0-9]{40,64})(?: (.*))?$/u.exec(line);
      if (!match) throw new Refused('RUNNER_SOURCE', 'unsupported history path; keep this run local');
      return { object: match[1], path: match[2] ?? '' };
    });
  const objects = [...new Set([...records.map(record => record.object), ...tags.flatMap(tag => tag.chain).filter(object => !knownTags.has(object))])];
  const names = new Map(records.map(record => [record.object, record.path]));
  for (const tag of tags) for (const object of tag.chain) names.set(object, tag.name);
  const historicalTrees = new Set();
  const config = source.protect ? { protect: source.protect } : sourceGit(root, ['ls-tree', '--name-only', source.commit, '--', 'pullboard.json']).trim()
    ? configFromSource(sourceGit(root, ['show', `${source.commit}:pullboard.json`])) : defaults();
  const metadata = sourceGit(root, ['cat-file', '--batch-check'], { input: objects.map(object => `${object}\n`).join('') });
  for (const line of metadata.split('\n').filter(Boolean)) {
    const match = /^[a-f0-9]{40,64} (blob|tree|commit|tag) (\d+)$/u.exec(line);
    if (!match || Number(match[2]) > MAX_BLOB_BYTES) throw new Refused('RUNNER_SCAN_LIMIT', 'a historical object exceeds the safe runner scan limit; keep this run local');
  }
  if (objects.length) {
    const scanFile = join(directory, 'history.scan');
    const output = openSync(scanFile, 'wx', 0o600);
    try { sourceGit(root, ['cat-file', '--batch'], { input: `${objects.join('\n')}\n`, stdio: ['pipe', output, 'pipe'] }); }
    finally { closeSync(output); }
    const input = openSync(scanFile, 'r');
    try {
      for (let index = 0; index < objects.length; index++) {
        const { object, type, data } = objectRecord(input);
        const path = names.get(object) || `history/${object}`;
        if (type === 'commit') {
          const tree = /^tree ([a-f0-9]{40,64})$/mu.exec(data.toString('utf8'))?.[1];
          if (!tree) throw new Refused('RUNNER_SOURCE', 'invalid historical commit; keep this run local');
          historicalTrees.add(tree);
        }
        if (type === 'tree') {
          let cursor = 0;
          while (cursor < data.length) {
            const space = data.indexOf(32, cursor), nul = data.indexOf(0, space + 1);
            if (space < cursor || nul < 0) throw new Refused('RUNNER_SOURCE', 'invalid historical tree; keep this run local');
            const mode = data.subarray(cursor, space).toString('ascii');
            const name = data.subarray(space + 1, nul).toString('utf8');
            const full = names.get(object) ? `${names.get(object)}/${name}` : name;
            if (mode === '160000' || protectedHistoryPath(full, config.protect)
              || secretsIn([{path:'historical tree',line:1,text:name}]).length) throw new Refused('RUNNER_SECRET', 'historical source includes a blocked private path or submodule; keep this run local');
            cursor = nul + 1 + source.commit.length / 2;
          }
          if (cursor !== data.length) throw new Refused('RUNNER_SOURCE', 'invalid historical tree; keep this run local');
        } else if (protectedHistoryPath(path, config.protect)
          || secretsIn(data.toString('utf8').split(/\r?\n/u).map((text, line) => ({ path, line: line + 1, text }))).length) {
          throw new Refused('RUNNER_SECRET', 'historical source failed its transfer scan; remove the private history or keep this run local');
        }
      }
    } finally { closeSync(input); rmSync(scanFile, { force: true }); }
  }
  // Check every full historical path, including reused cached blobs moved beneath a newly blocked prefix.
  for (const tree of historicalTrees) {
    for (const record of sourceGit(root, ['ls-tree', '-r', '-z', '--full-tree', tree]).split('\0').filter(Boolean)) {
      const match = /^(\d+) (\w+) [a-f0-9]{40,64}\t([\s\S]+)$/u.exec(record);
      if (!match || match[2] !== 'blob' || protectedHistoryPath(match[3], config.protect)) {
        throw new Refused('RUNNER_SECRET', 'historical source includes a blocked private path or submodule; keep this run local');
      }
    }
  }
  const pack = join(directory, 'source.pack');
  const output = openSync(pack, 'wx', 0o600);
  try { sourceGit(root, ['pack-objects', '--stdout'], { input: objects.map(object => `${object}\n`).join(''), stdio: ['pipe', output, 'pipe'] }); }
  finally { closeSync(output); }
  return pack;
}

/** Quote one remote shell argument without permitting substitutions or expansion. */
function shellWord(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/** Give the SSH client connection necessities only; arbitrary caller secrets cannot be forwarded. */
function sshEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'TMPDIR', 'SystemRoot', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

/** Snapshot, scan and pin the actual tooling bytes independently of the project being tested. */
function trustedTooling() {
  const files = Object.fromEntries([...RUNTIME_NAMES, 'runner-worker.js']
    .map(name => [name, readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')]));
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
    if (!selected || Object.entries(files).some(([name, source]) => sourceGit(TOOL_ROOT, ['show', `${selected.commit}:src/${name}`]) !== source)) {
      throw new Refused('RUNNER_TOOLING_CHANGED', 'runner tooling differs from its selected committed revision; restore or commit the tooling before remote execution');
    }
    provenance = { ...provenance, kind: 'git-checkout', ...selected };
  }
  const tooling = { ...provenance, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
  const runtimeFiles = Object.fromEntries(RUNTIME_NAMES.map(name => [name, files[name]]));
  return { worker: files['runner-worker.js'], tooling,
    runtime: { files: runtimeFiles, sha256: createHash('sha256').update(JSON.stringify(runtimeFiles)).digest('hex') } };
}

/** Install a complete immutable module capsule without reading the job's stdin stream. */
function installRuntime(payload, expected, configuredRoot) {
  const bytes = gunzipSync(Buffer.from(payload, 'base64'), { maxOutputLength: 1_048_576 });
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('invalid capsule identity');
  const files = JSON.parse(bytes);
  const home = process.env.HOME;
  if (!configuredRoot && (!home || !isAbsolute(home))) throw new Error('runner home must be absolute');
  const root = configuredRoot || join(home, '.pullboard-runner');
  const directory = join(root, 'runtime', expected);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  const build = mkdtempSync(join(dirname(directory), `${expected}.build-`));
  try {
    mkdirSync(join(build, 'src'), { mode: 0o700 });
    writeFileSync(join(build, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
    for (const [name, source] of Object.entries(files)) writeFileSync(join(build, 'src', name), source, { mode: 0o600 });
    try { renameSync(build, directory); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    if (readFileSync(join(directory, 'package.json'), 'utf8') !== '{"type":"module"}\n'
      || Object.entries(files).some(([name, source]) => readFileSync(join(directory, 'src', name), 'utf8') !== source)) {
      throw new Error('trusted capsule does not match the request');
    }
  } finally { rmSync(build, { recursive: true, force: true }); }
}

/** Install pinned bytes first, then replace the SSH shell with the file-based worker. */
function remoteWorkerCommand(runner, worker, tooling, runtime) {
  const files = { ...runtime.files, 'runner-worker.js': worker };
  const payload = gzipSync(Buffer.from(JSON.stringify(files))).toString('base64');
  const installer = `import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
${installRuntime.toString()}
installRuntime(${JSON.stringify(payload)}, ${JSON.stringify(tooling.sha256)}, ${JSON.stringify(runner.root ?? '')});`;
  const node = shellWord(runner.node ?? 'node');
  const suffix = `/runtime/${tooling.sha256}/src/runner-worker.js`;
  const entry = runner.root ? shellWord(runner.root + suffix) : `"$HOME"${shellWord('/.pullboard-runner' + suffix)}`;
  return `${node} --input-type=module -e ${shellWord(installer)} && exec ${node} ${entry}`;
}

/** Use only a credential-free anonymous HTTPS origin; SSH authentication is never forwarded. */
function anonymousOrigin(root) {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 4096 });
  if (result.status !== 0) return undefined;
  let address = result.stdout.trim();
  const ssh = /^git@([A-Za-z0-9][A-Za-z0-9.-]*):([^\s?#]+)$/u.exec(address);
  if (ssh) address = `https://${ssh[1]}/${ssh[2]}`;
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || address.length > 2048) return undefined;
    if (secretsIn([{path:'anonymous origin',line:1,text:address}]).length) return undefined;
    return url.href;
  } catch { return undefined; }
}

/** Prepare the pinned request before negotiating history; cleanup owns only its scratch directory. */
function requestFor(root, command, { runner, source, browser = false, byLaunch, pipefail = false, stages = false, waivers = [], metadata = {}, privateCheck, checkedSource, rawOutputPath }) {
  runner = validateRunner(runner);
  const current = runnerSource(root);
  if (!current || (source && (current.commit !== source.commit || current.tree !== source.tree))) {
    throw new Refused('RUNNER_SOURCE_CHANGED', 'the queued source changed; restore the committed tree and retry the run');
  }
  const trustedMode = privateCheck ? privateCheckEnvelope(privateCheck) : null;
  let selected = current;
  if (trustedMode) {
    if (!checkedSource || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(checkedSource.commit ?? '')
      || sourceGit(root, ['rev-parse', `${checkedSource.commit}^{tree}`]).trim() !== checkedSource.tree
      || command !== trustedMode.check || typeof rawOutputPath !== 'string' || !isAbsolute(rawOutputPath)) {
      throw new Refused('RUNNER_SOURCE_CHANGED', 'the trusted private check source or output capture is invalid; restore its pinned commit and retry');
    }
    const owner = configFromSource(sourceGit(root, ['show', `${trustedMode.policyCommit}:pullboard.json`]));
    selected = { commit: checkedSource.commit, tree: checkedSource.tree,
      extraCommits: [...new Set([trustedMode.policyCommit, trustedMode.trunk.commit])], protect: owner.protect };
  }
  if (secretsIn([command, trustedMode?.install ?? ''].flatMap(value => value.split('\n')).map((text, index) => ({ path: 'run command', line: index + 1, text }))).length) {
    throw new Refused('RUNNER_SECRET', 'the run command contains a possible secret; use a command that does not transfer credentials');
  }
  const protect = sourceObjects(root, selected);
  for (const commit of [selected.commit, ...(selected.extraCommits ?? [])]) protectHistory(root, { commit }, protect);
  const origin = anonymousOrigin(root);
  const originBase = origin ? originAncestor(root, selected) : undefined;
  const tags = candidateTags(root, selected);
  const repoId = createHash('sha256').update(realpathSync(repoInfo(root).commonDir)).digest('hex');
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-runner-send-'));
  try {
    const { worker, tooling, runtime } = trustedTooling();
    const projection = metadata.landing === true && Array.isArray(waivers) ? waivers.filter(entry => ['file', 'name'].includes(entry?.kind) && typeof entry.test === 'string' && entry.test).map(({ kind, test }) => ({ kind, test })) : [];
    if (secretsIn([{ path: 'runner continuation', line: 1, text: JSON.stringify(projection) }]).length) throw new Refused('RUNNER_SECRET', 'the continuation projection contains a possible secret; keep this run local');
    const spec = { version: 1, id: randomUUID(), repoId, ...(originBase ? { origin, originBase } : {}), runtime, tooling, tags, commit: selected.commit, tree: selected.tree, command, pipefail, slots: runner.slots,
      ...(trustedMode ? { trustedMode } : {}),
      browser: runner.browser, browserRequired: browser, guiRequired: metadata.gui === true, landing: metadata.landing === true,
      ...(metadata.landing === true && metadata.timeoutMs ? { timeoutMs: metadata.timeoutMs } : {}),
      // The classification this controller used, so the runner never reclassifies by its own settings (#1043).
      browserByLaunch: byLaunch ?? carriedBrowserByLaunch() ?? readMachineSettingsFile()?.gate?.browserByLaunch === true,
      ...(stages ? { stageMarker: `PULLBOARD_STAGE_${randomUUID().replaceAll('-', '')}` } : {}), waivers: projection,
      itemCheck: metadata.itemCheck === true, diagnostic: metadata.diagnostic === true, timing: metadata.timing === true,
      item: String(metadata.item ?? ''), kind: String(metadata.kind ?? ''), ...(runner.root ? { root: runner.root } : {}),
      ...(typeof metadata.main === 'string' && /^[0-9a-f]{40,64}$/u.test(metadata.main) ? { main: metadata.main } : {}) };
    const encodedSpec = Buffer.from(JSON.stringify(spec));
    if (encodedSpec.length > 1024 ** 2) throw new Refused('RUNNER_REQUEST_LIMIT', 'runner tooling request exceeds its safe transfer limit; keep this run local');
    const remote = remoteWorkerCommand(runner, worker, tooling, runtime);
    // These are transport hang ceilings, independent of the command's execution budget.
    return { spec, runner, args: ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
      '--', runner.host, remote], root, source: selected, ...(trustedMode ? { rawOutputPath } : {}), directory, frame: Buffer.concat([Buffer.from(`${encodedSpec.length}\n`), encodedSpec]), env: sshEnvironment(),
    cleanup() { rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Verify exact source and complete raw output before accepting any remote status. */
function resultFrom(request, result) {
  const output = result.stdout ?? Buffer.alloc(0);
  const lines = String(result.stderr ?? '').split(/\r?\n/u);
  const prefix = `PULLBOARD_RUNNER_RESULT ${request.spec.id} `;
  const receipts = lines.filter(line => line.startsWith(prefix));
  let receipt;
  try {
    if (receipts.length !== 1) throw new Error('missing receipt');
    receipt = JSON.parse(Buffer.from(receipts[0].slice(prefix.length), 'base64').toString('utf8'));
  } catch { throw new RunnerDropped(request.runner.host); }
  if (result.error || result.status !== 0 || receipt.id !== request.spec.id || receipt.commit !== request.spec.commit
    || receipt.tree !== request.spec.tree || receipt.runtimeSha256 !== request.spec.runtime.sha256 || receipt.toolingSha256 !== request.spec.tooling.sha256 || !Number.isInteger(receipt.code) || receipt.code < 0 || receipt.code > 255
    || typeof receipt.root !== 'string' || !Number.isFinite(receipt.wallMs) || receipt.wallMs < 0
    || receipt.outputSha256 !== (request.spec.trustedMode ? result.rawSha256 : createHash('sha256').update(output).digest('hex'))) {
    throw new RunnerDropped(request.runner.host);
  }
  if (receipt.gui !== undefined && ![true, false, null].includes(receipt.gui)) throw new RunnerDropped(request.runner.host);
  // This field is bound to this exact request and output digest, never read from command text.
  recordRunnerGui(request.runner.host, receipt.gui ?? null);
  if (receipt.refused === 'RUNNER_GUI_SESSION_REQUIRED') {
    if (!request.spec.guiRequired || receipt.gui === true || receipt.code === 0) throw new RunnerDropped(request.runner.host);
    const refused = new Refused('RUNNER_GUI_SESSION_REQUIRED', `runner ${request.runner.host} has no confirmed GUI session at job start; rerun this GUI-marked file locally or register a logged-in GUI runner`);
    refused.runnerAttempt = { host: request.runner.host, exitCode: receipt.code, output: output.toString('utf8'), gui: receipt.gui ?? null };
    throw refused;
  }
  if (receipt.timedOut !== undefined && (receipt.timedOut !== true || !request.spec.timeoutMs || receipt.code === 0)) throw new RunnerDropped(request.runner.host);
  if (receipt.refused !== undefined) {
    if (typeof receipt.refused !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(receipt.refused) || receipt.code === 0) throw new RunnerDropped(request.runner.host);
    // The runner answered, so this is a named failure, not a dropped transport to requeue.
    throw new Refused('RUNNER_SETUP_REFUSED', `runner ${request.runner.host} refused this run before it started: [${receipt.refused}] from its own resource pool; run pullboard resources and pullboard settings on ${request.runner.host} to fix that pool, then run again`);
  }
  // The runner classified any file denial against its own checkout; only its evidence is trusted here.
  const sandboxBlocked = receipt.denial === undefined ? null : remoteFileDenial(receipt.denial, request.runner.host);
  if (receipt.denial !== undefined && (!sandboxBlocked || receipt.code === 0)) throw new RunnerDropped(request.runner.host);
  let staged = null;
  if (request.spec.stageMarker && !receipt.signal) {
    const split = gateStages(request.spec.command);
    if (split) {
      const parsed = readStages(output.toString('utf8'), request.spec.stageMarker, split.length);
      const pipes = receipt.pipeStatuses;
      staged = { ...parsed, stages: parsed.stages.map((stage, index) => split[index].pipeline.length > 1
        ? { ...stage, pipeline: Array.isArray(pipes) && pipes.length === split.length && Array.isArray(pipes[index])
          && pipes[index].length === split[index].pipeline.length && pipes[index].every(entry => entry && (entry.status === null || Number.isInteger(entry.status) && entry.status >= 0 && entry.status <= 255) && (entry.output === null || typeof entry.output === 'string'))
          ? pipes[index] : null } : stage) };
    }
  }
  let privateResult = null;
  if (request.spec.trustedMode) {
    try {
      if (result.rawOutputPath !== request.rawOutputPath || statSync(result.rawOutputPath).size !== result.rawBytes) throw new Error('missing complete private-check capture');
      privateResult = privateCheckPhases(request.spec.trustedMode, receipt.trustedMode, result.rawBytes);
      if ((privateResult.state === 'pass') !== (receipt.code === 0 && !receipt.signal)) throw new Error('inconsistent private-check completion');
    } catch { throw new RunnerDropped(request.runner.host); }
  } else if (receipt.trustedMode !== undefined) throw new RunnerDropped(request.runner.host);
  const text = staged?.output ?? output.toString('utf8');
  if (receipt.environment !== undefined && environmentProblem(receipt.environment)) throw new RunnerDropped(request.runner.host);
  if (receipt.testRuntimes != null && !testRuntimeRows(receipt.testRuntimes)) throw new RunnerDropped(request.runner.host);
  if (receipt.browserRefused !== undefined && (receipt.browserRefused !== true || receipt.code === 0 || request.spec.browserRequired)) throw new RunnerDropped(request.runner.host);
  const admission = remoteAdmission(receipt.executionAdmission);
  if (request.spec.timing === true && (receipt.timing !== true || !admission)) throw new RunnerDropped(request.runner.host);
  // Only the lease guard's own receipt counts; text a test prints is never a refusal (#1043).
  if (receipt.browserRefused === true) {
    const refused = new Refused('RUNNER_BROWSER_SLOT_REQUIRED', `runner ${request.runner.host} refused this run's lease for want of a browser slot (BROWSER_SLOT_REQUIRED)`);
    refused.runnerAttempt = { host: request.runner.host, exitCode: receipt.code, output: text };
    throw refused;
  }
  return { isGreen: receipt.code === 0 && !receipt.signal, output: text, sandboxBlocked, ...(receipt.timedOut ? { timedOut: true } : {}),
    environment: receipt.environment ?? null, testRuntimes: receipt.testRuntimes ?? null, executionCapabilities: { gui: receipt.gui ?? null },
    ...(request.spec.stageMarker ? { stages: staged?.stages ?? null } : {}),
    seconds: Math.round(receipt.wallMs / 1000), exitCode: receipt.code,
    executionRunner: request.runner.host, executionRoot: receipt.root, remoteWallMs: receipt.wallMs,
    executionSource: { commit: receipt.commit, tree: receipt.tree, tooling: request.spec.tooling },
    ...(privateResult ? { privateCheck: { ...privateResult, receipt: receipt.trustedMode }, rawOutputPath: result.rawOutputPath, rawOutputSha256: result.rawSha256 } : {}),
    executionMain: request.spec.main && receipt.main === request.spec.main ? receipt.main : null, executionLoad: remoteLoad(receipt.load), executionAdmission: admission };
}

/** Validate executor-sampled admission intervals and both load timestamps before trusting timing isolation. */
function remoteAdmission(value) {
  if (!value || !Number.isSafeInteger(value.slots) || value.slots < 1) return null;
  const admitted = Date.parse(value.admittedAt);
  const finished = Date.parse(value.finishedAt);
  const startAt = Date.parse(value.load?.start?.at);
  const endAt = Date.parse(value.load?.end?.at);
  const start = remoteLoad(value.load?.start);
  const end = remoteLoad(value.load?.end);
  if (![admitted, finished, startAt, endAt].every(Number.isFinite) || finished < admitted
    || startAt < admitted || endAt < startAt || finished !== endAt || !start || !end) return null;
  if (typeof value.exclusive !== 'boolean' || !Array.isArray(value.unfencedClients)
    || value.unfencedClients.some(client => !client || typeof client.agent !== 'string'
      || !Number.isSafeInteger(client.pid) || client.pid < 1 || typeof client.started !== 'string')
    || value.exclusive && value.unfencedClients.length > 0) return null;
  return { slots: value.slots, admittedAt: value.admittedAt, finishedAt: value.finishedAt,
    exclusive: value.exclusive, unfencedClients: value.unfencedClients,
    load: { start: { at: value.load.start.at, ...start }, end: { at: value.load.end.at, ...end } } };
}

/** The execution host's load from a receipt, or null when any part of it is missing or malformed (#925). */
function remoteLoad(load) {
  const average = Array.isArray(load?.average) && load.average.length === 3 && load.average.every((value) => Number.isFinite(value) && value >= 0) ? load.average : null;
  return average && Number.isInteger(load.cpus) && load.cpus > 0 && Number.isInteger(load.freeMB) && load.freeMB >= 0
    ? { average, cpus: load.cpus, freeMB: load.freeMB } : null;
}

/** Keep synchronous gate callers on the same negotiated transport as asynchronous comparisons. */
export function runOnRunner(root, command, options) {
  const script = `import { runOnRunnerAsync } from ${JSON.stringify(import.meta.url)};
let input=''; for await (const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input);
const canceled=new AbortController();
const abort=()=>canceled.abort();
process.on('SIGTERM',abort); process.on('SIGHUP',abort); process.stdout.on('error',abort);
// Budget: check actual parent identity every second while the negotiated SSH transport is active.
const parentWatch=setInterval(()=>{if(process.ppid!==request.parentPid)abort();},1000);
if(process.ppid!==request.parentPid)abort();
try { process.stdout.write(JSON.stringify({result:await runOnRunnerAsync(request.root,request.command,{...request.options,signal:canceled.signal})})); }
catch(error) { process.stdout.write(JSON.stringify({error:{name:error.name,code:error.code,message:error.message,host:error.host,runnerAttempt:error.runnerAttempt}})); process.exitCode=1; }
finally {clearInterval(parentWatch);}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, input: JSON.stringify({ root, command, options, parentPid: process.pid }), encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES * 6 + 1024 ** 2,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let reply;
  try { reply = JSON.parse(child.stdout); } catch { throw new RunnerDropped(options.runner.host); }
  if (reply.error?.name === 'Refused') {
    const prefix = `[${reply.error.code}] `;
    const refused = new Refused(reply.error.code, reply.error.message.startsWith(prefix) ? reply.error.message.slice(prefix.length) : reply.error.message);
    if (reply.error.runnerAttempt) refused.runnerAttempt = reply.error.runnerAttempt;
    throw refused;
  }
  if (reply.error || child.error || child.status !== 0) throw new RunnerDropped(options.runner.host);
  return reply.result;
}

/** Negotiate missing history objects while the remote cache lease stays held in one SSH session. */
export async function runOnRunnerAsync(root, command, options) {
  if (options.signal?.aborted) throw new RunnerDropped(options.runner.host);
  const request = requestFor(root, command, options);
  let removeAbort = () => {};
  let rawFd = null;
  try {
    if (request.rawOutputPath) rawFd = openSync(request.rawOutputPath, 'wx', 0o600);
    const child = spawn('ssh', request.args, { env: request.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], diagnostics = [];
    let bytes = 0, error, control = '', requested = false, transfer = null, cleanupReason = '';
    const rawHash = createHash('sha256');
    let rawBytes = 0, head = Buffer.alloc(0), tail = Buffer.alloc(0);
    const half = 4 * 1024 ** 2;
    const abort = () => { error ??= new Error('runner transport canceled'); child.stdin.destroy(); child.kill('SIGTERM'); };
    options.signal?.addEventListener('abort', abort, { once: true });
    removeAbort = () => options.signal?.removeEventListener('abort', abort);
    if (options.signal?.aborted) abort();
    /** Bound both protocol streams before retaining a complete result. */
    const capture = (target, chunk, raw = false) => {
      if (raw && rawFd !== null) {
        if (error) return;
        try {
          for (let offset = 0; offset < chunk.length;) {
            const written = writeSync(rawFd, chunk, offset, chunk.length - offset);
            if (written <= 0) throw new Error('private-check output made no capture progress');
            offset += written;
          }
          rawHash.update(chunk); rawBytes += chunk.length;
          const take = Math.min(chunk.length, half - head.length);
          if (take) head = Buffer.concat([head, chunk.subarray(0, take)]);
          if (chunk.length > take) tail = Buffer.concat([tail, chunk.subarray(take)]).subarray(-half);
        } catch { error = new Refused('RUNNER_OUTPUT_LIMIT', 'the full private-check output could not be captured; restore its artifact storage before retrying'); child.kill('SIGTERM'); }
        return;
      }
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { error = new Refused('RUNNER_OUTPUT_LIMIT', 'runner output exceeded 64 MiB; reduce command output or keep this run local'); child.kill(); }
      else target.push(chunk);
    };
    child.stdout.on('data', chunk => capture(output, chunk, true));
    child.stderr.on('data', chunk => {
      capture(diagnostics, chunk);
      control += chunk.toString('utf8');
      // Budget: eight MiB of component receipts plus base64/JSON framing, inside the total 64-MiB bound.
      if (control.length > 16 * 1024 ** 2) { error = new Error('runner control frame exceeded limit'); child.kill(); return; }
      let newline;
      while ((newline = control.indexOf('\n')) >= 0) {
        const line = control.slice(0, newline); control = control.slice(newline + 1);
        const cleanupPrefix = `PULLBOARD_RUNNER_CLEANUP_UNVERIFIED ${request.spec.id} `;
        if (line.startsWith(cleanupPrefix)) cleanupReason = line.slice(cleanupPrefix.length, cleanupPrefix.length + 240);
        if (line === `PULLBOARD_RUNNER_CLEANUP_TIMEOUT ${request.spec.id}`) {
          error = new Refused('RUNNER_CLEANUP_TIMEOUT', `runner ${request.runner.host} could not verify cleanup within 30 seconds${cleanupReason ? ': ' + cleanupReason : ''}; inspect job ${request.spec.id} under its runner namespace before another run`);
          child.stdin.destroy(); child.kill('SIGTERM'); return;
        }
        const prefix = `PULLBOARD_RUNNER_NEED ${request.spec.id} `;
        if (!line.startsWith(prefix)) continue;
        if (requested) { error = new Error('duplicate runner inventory'); child.kill(); return; }
        requested = true;
        transfer = (async () => {
          const inventory = JSON.parse(Buffer.from(line.slice(prefix.length), 'base64').toString('utf8'));
          if (!Array.isArray(inventory.tips) || inventory.tips.length > 1024
            || inventory.tips.some(tip => typeof tip !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tip))) {
            throw new Error('invalid runner inventory');
          }
          if (!Array.isArray(inventory.tagObjects) || inventory.tagObjects.length > 8_192
            || inventory.tagObjects.some(object => typeof object !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(object))) {
            throw new Error('invalid runner tag inventory');
          }
          const pack = historyPack(root, request.source, inventory.tips, request.directory, request.spec.tags, inventory.tagObjects);
          await pipeline(createReadStream(pack), child.stdin);
        })().catch(failure => { error = failure; child.stdin.destroy(); child.kill(); });
      }
    });
    child.stdin.on('error', failure => { if (failure.code !== 'EPIPE') error ??= failure; });
    child.once('error', failure => { error = failure; });
    child.stdin.write(request.frame);
    const status = await new Promise(resolve => child.once('close', resolve));
    if (transfer) await transfer;
    if (error instanceof Refused) throw error;
    if (rawFd !== null) { closeSync(rawFd); rawFd = null; }
    const bounded = request.rawOutputPath ? Buffer.concat([head, ...(rawBytes > half * 2 ? [Buffer.from('\n[output capped at 8 MiB; middle omitted]\n')] : []), tail]) : Buffer.concat(output);
    return resultFrom(request, { status, error, stdout: bounded, stderr: Buffer.concat(diagnostics),
      ...(request.rawOutputPath ? { rawOutputPath: request.rawOutputPath, rawBytes, rawSha256: rawHash.digest('hex') } : {}) });
  } finally { if (rawFd !== null) closeSync(rawFd); removeAbort(); request.cleanup(); }
}
