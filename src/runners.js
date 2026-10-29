import { sourcePreparationFields } from './runner-overhead.js';
import { sampleRunnerLoad } from './runner-load.js';
import { localRunnerDescriptor } from './runner-load.js';
import { carriedRunnerTrunk } from './runner-policy.js';
import { probeRunnerTransport } from './runner-transport.js';
import { claimRunnerLaunch } from './runner-transport.js';
import { recoveryIdentity } from './runner-transport.js';
import { removeGitRepositorySelectors } from './git-child-selectors.js';
import { installRunnerPackage } from './runner-package-install.js';
import {
  captureRunnerTooling,
  currentRunnerTooling,
} from './runner-tooling-snapshot.js';
import {
  validateRunner,
  runnerSource,
  RunnerDropped,
} from './gate-policy-load.js';
export { validateRunner, runnerSource, RunnerDropped };
import { validRunnerTrunk } from './runner-policy.js';
/** Exact committed source and bounded, credential-free SSH execution for machine runners [C7]. */
export { placeRunner, runnerStage } from './runner-stage-model.js';
import { importTestResults } from './test-result-store.js';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
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
import { testRuntimeRows } from './execution-environment.js';
import { environmentProblem } from './config.js';
import {
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
import { runnerPhaseFields } from './timing.js';
import {
  gateStages,
  readStages,
} from './gate-stages.js';
import { remoteFileDenial } from './sandbox-denial.js';
import {
  carriedBrowserByLaunch,
  readMachineSettingsFile,
} from './queue-settings.js';
import { machineSettingsFile } from './machine-home.js';

// Budget: 64 MiB bounds worst-case JSON bridge escaping below Node string limits.
const MAX_OUTPUT_BYTES = 64 * 1024 ** 2;
const MAX_BLOB_BYTES = 8 * 1024 ** 2;
const MAX_HISTORY_TAGS = 1_024;
const MAX_TAG_CHAIN = 8;
const TOOL_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOADED_TOOLING = loadedTooling();

/** Pin the actual derived runtime and controller generation before any later dispatch. */
function loadedTooling() {
  try { return captureRunnerTooling(TOOL_ROOT); }
  catch (problem) { return problem?.code === 'RUNNER_TOOLING_FILES' ? { problem } : null; }
}


/** Bound diagnostic text, exclude protocol payloads, and suppress any possible credential instead of echoing it. */
function transportText(value) {
  const text = String(value ?? '').split(/\r?\n/u).filter(line => !line.startsWith('PULLBOARD_RUNNER_')).join('\n').slice(-8192);
  return secretsIn(text.split('\n').map((line, index) => ({ path: 'runner transport', line: index + 1, text: line }))).length
    ? '[possible credential redacted]' : text;
}

/** Preserve which transport/protocol check failed without retaining source capsules, credentials or command output. */
function runnerFailure(request, result, reason) {
  return new RunnerDropped(request.runner.host, { reason: request.admissionDeadlineExceeded ? 'admission-deadline' : reason, request: request.spec?.id ?? null,
    source: request.spec?.commit ?? null, tree: request.spec?.tree ?? null,
    tooling: request.spec?.tooling?.sha256 ?? null, recovery: request.spec?.recovery ?? null, phase: request.phase ?? 'connect',
    command: ['ssh', ...(request.args ?? []).slice(0, -1), '[pinned Pullboard worker]'],
    exitCode: result.status ?? null, signal: result.signal ?? null,
    error: result.error ? { code: result.error.code ?? result.error.name, message: transportText(result.error.message) } : null,
    stderr: transportText(result.stderr), outputBytes: result.rawBytes ?? Buffer.byteLength(result.stdout ?? '') });
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

/** Read admitted protection rules from its immutable commit, retaining non-board defaults. */
function protectionAt(root, commit) {
  const record = sourceGit(root, ['ls-tree', '-z', commit, '--', 'pullboard.json']);
  const object = record.match(/^\d+ blob ([a-f0-9]{40,64})\t/u)?.[1];
  return object ? configFromSource(sourceGit(root, ['cat-file', 'blob', object])).protect : defaults().protect;
}

/** Apply current protection rules to all selected historical names before any anonymous cache seed. */
function protectHistory(root, source, policies) {
  const paths = [...new Set(sourceGit(root, ['log', '--format=', '--name-only', '-z', '--no-renames', '--root', '-m', '--full-history', source.commit])
    .split('\0').filter(Boolean))];
  if (paths.some(path => policies.some(protect => protectedHistoryPath(path, protect)))) {
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
  const inherited = { ...process.env };
  removeGitRepositorySelectors(inherited, process.stderr.write.bind(process.stderr));
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'TMPDIR', 'SystemRoot', 'WINDIR']) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  return { ...env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

/** Share the loaded generation guard; async callers leave the closure scan to their fresh controller. */
function loadedToolingFiles({ rescan = true } = {}) {
  return currentRunnerTooling(TOOL_ROOT, LOADED_TOOLING, { rescan });
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
function trustedTooling() {
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
function remoteWorkerCommand(runner, worker, tooling, runtime, extra = '', recovery = null) {
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
async function requestFor(root, command, { runner, source, browser = false, byLaunch, pipefail = false, stages = false, waivers = [], metadata = {}, privateCheck, checkedSource, rawOutputPath }, { privateCheckEnvelope }) {
  runner = validateRunner(runner);
  const current = runnerSource(root);
  if (!current || (source && (current.commit !== source.commit || current.tree !== source.tree))) {
    throw new Refused('RUNNER_SOURCE_CHANGED', 'the queued source changed; restore the committed tree and retry the run');
  }
  const trustedMode = privateCheck ? privateCheckEnvelope(privateCheck) : null;
  let selected = current;
  if (!trustedMode && metadata.trunk !== undefined) {
    if (!validRunnerTrunk(metadata.trunk, current.commit)) throw new Refused('NO_POLICY', 'the admitted runner policy is invalid; rerun through the controller with its pinned coordinator policy');
    selected = { ...current, extraCommits: [metadata.trunk.commit] };
  }
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
  const protection = [sourceObjects(root, selected)];
  if (!trustedMode && metadata.trunk) protection.push(protectionAt(root, metadata.trunk.commit));
  for (const commit of [selected.commit, ...(selected.extraCommits ?? [])]) protectHistory(root, { commit }, protection);
  const origin = anonymousOrigin(root);
  const originBase = origin ? originAncestor(root, selected) : undefined;
  const tags = candidateTags(root, selected);
  const repoId = createHash('sha256').update(realpathSync(repoInfo(root).commonDir)).digest('hex');
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-runner-send-'));
  try {
    // A caller that opted out of reuse (a test's own fixture runner) sends no exchange, so its worker runs every file.
    const reuse = process.env.PULLBOARD_TEST_REUSE !== '0';
    // Loaded on demand: read commands that import this module never pay for the key analyzer.
    const exchange = reuse ? await (await import('./test-action-transfer.js')).prepareTestResultExchange(root, command, selected.commit) : null;
    const { worker, tooling, runtime } = trustedTooling();
    const projection = metadata.landing === true && Array.isArray(waivers) ? waivers.filter(entry => ['file', 'name'].includes(entry?.kind) && typeof entry.test === 'string' && entry.test).map(({ kind, test }) => ({ kind, test })) : [];
    if (secretsIn([{ path: 'runner continuation', line: 1, text: JSON.stringify(projection) }]).length) throw new Refused('RUNNER_SECRET', 'the continuation projection contains a possible secret; keep this run local');
    const stage = /^[a-z][a-z0-9-]{0,63}$/u.test(metadata.testStage ?? '') ? metadata.testStage : metadata.landing ? 'land' : 'focused';
    const id = randomUUID();
    const spec = { version: 1, id, recovery: { version: 1, launchFence: 1, request: id, nonce: randomUUID(), tooling: tooling.sha256 }, repoId, ...(originBase ? { origin, originBase } : {}), runtime, tooling, tags, commit: selected.commit, tree: selected.tree, command, pipefail, slots: runner.slots,
      ...(reuse ? { testResults: { inputKeys: exchange?.inputKeys ?? [], packet: exchange?.packet ?? null, stage, origin: runner.host } } : {}),
      ...(trustedMode ? { trustedMode } : {}),
      ...(!trustedMode && metadata.trunk ? { trunk: { ...metadata.trunk } } : {}),
      browser: runner.browser, browserRequired: browser, guiRequired: metadata.gui === true, landing: metadata.landing === true, auditCoverage: metadata.auditCoverage === true,
      ...(typeof metadata.timingRunId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(metadata.timingRunId) ? { timingRunId: metadata.timingRunId } : {}),
      ...(metadata.landing === true && metadata.timeoutMs ? { timeoutMs: metadata.timeoutMs } : {}),
      // The classification this controller used, so the runner never reclassifies by its own settings (#1043).
      browserByLaunch: byLaunch ?? carriedBrowserByLaunch() ?? readMachineSettingsFile(machineSettingsFile())?.gate?.browserByLaunch === true,
      ...(stages ? { stageMarker: `PULLBOARD_STAGE_${randomUUID().replaceAll('-', '')}` } : {}), waivers: projection,
      itemCheck: metadata.itemCheck === true, diagnostic: metadata.diagnostic === true, timing: metadata.timing === true,
      item: String(metadata.item ?? ''), kind: String(metadata.kind ?? ''), ...(runner.root ? { root: runner.root } : {}),
      ...(typeof metadata.main === 'string' && /^[0-9a-f]{40,64}$/u.test(metadata.main) ? { main: metadata.main } : {}) };
    let encodedSpec = Buffer.from(JSON.stringify(spec));
    // Optional cache bytes cannot make an otherwise valid runner request fail its existing bound.
    if (encodedSpec.length > 1024 ** 2 && spec.testResults) {
      spec.testResults.packet = null;
      encodedSpec = Buffer.from(JSON.stringify(spec));
    }
    if (encodedSpec.length > 1024 ** 2 && spec.testResults) {
      spec.testResults.inputKeys = [];
      encodedSpec = Buffer.from(JSON.stringify(spec));
    }
    if (encodedSpec.length > 1024 ** 2) throw new Refused('RUNNER_REQUEST_LIMIT', 'runner tooling request exceeds its safe transfer limit; keep this run local');
    const remote = remoteWorkerCommand(runner, worker, tooling, runtime, '', spec.recovery);
    // These are transport hang ceilings, independent of the command's execution budget.
    return { spec, runner, exchange, args: ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
      '--', runner.host, remote], root, source: selected, ...(trustedMode ? { rawOutputPath } : {}), directory, frame: Buffer.concat([Buffer.from(`${encodedSpec.length}\n`), encodedSpec]), env: sshEnvironment(),
    cleanup() { rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Verify exact source and complete raw output before accepting any remote status. */
function resultFrom(request, result, { privateCheckPhases }) {
  const output = result.stdout ?? Buffer.alloc(0);
  const lines = String(result.stderr ?? '').split(/\r?\n/u);
  const prefix = `PULLBOARD_RUNNER_RESULT ${request.spec.id} `;
  const receipts = lines.filter(line => line.startsWith(prefix));
  // A spec rejected before admission has no trustworthy job receipt. Preserve its named failure,
  // never manufacture source/proof metadata or treat the refusal as a transport retry.
  if (!result.error && Number.isInteger(result.status) && result.status > 0 && result.status <= 255 && output.length === 0 && receipts.length === 0
      && lines.filter(line => line === 'PULLBOARD_RUNNER_SPEC_REFUSED invalid work specification').length === 1) {
    const refused = new Refused('RUNNER_WORK_SPEC', `runner ${request.runner.host} refused an invalid work specification before execution`);
    refused.runnerAttempt = { host: request.runner.host, exitCode: result.status, output: output.toString('utf8'), reason: 'invalid work specification' };
    throw refused;
  }

  let receipt;
  try {
    if (receipts.length !== 1) throw new Error('missing receipt');
    receipt = JSON.parse(Buffer.from(receipts[0].slice(prefix.length), 'base64').toString('utf8'));
  } catch { throw runnerFailure(request, result, receipts.length === 1 ? 'receipt-json' : 'receipt-count'); }
  if (result.error || result.status !== 0 || receipt.id !== request.spec.id || receipt.commit !== request.spec.commit
    || receipt.tree !== request.spec.tree || receipt.runtimeSha256 !== request.spec.runtime.sha256 || receipt.toolingSha256 !== request.spec.tooling.sha256 || !Number.isInteger(receipt.code) || receipt.code < 0 || receipt.code > 255
    || typeof receipt.root !== 'string' || !Number.isFinite(receipt.wallMs) || receipt.wallMs < 0
    || receipt.outputSha256 !== (request.spec.trustedMode ? result.rawSha256 : createHash('sha256').update(output).digest('hex'))) {
    throw runnerFailure(request, result, result.error ? 'local-transport-error' : result.status !== 0 ? 'ssh-exit' : 'receipt-binding');
  }
  if (receipt.gui !== undefined && ![true, false, null].includes(receipt.gui)) throw runnerFailure(request, result, 'gui-metadata');
  // This field is bound to this exact request and output digest, never read from command text.
  recordRunnerGui(request.runner.host, receipt.gui ?? null);
  if (receipt.refused === 'RUNNER_GUI_SESSION_REQUIRED') {
    if (!request.spec.guiRequired || receipt.gui === true || receipt.code === 0) throw runnerFailure(request, result, 'gui-refusal-binding');
    const refused = new Refused('RUNNER_GUI_SESSION_REQUIRED', `runner ${request.runner.host} has no confirmed GUI session at job start; rerun this GUI-marked file locally or register a logged-in GUI runner`);
    refused.runnerAttempt = { host: request.runner.host, exitCode: receipt.code, output: output.toString('utf8'), gui: receipt.gui ?? null };
    throw refused;
  }
  if (receipt.timedOut !== undefined && (receipt.timedOut !== true || !request.spec.timeoutMs || receipt.code === 0)) throw runnerFailure(request, result, 'timeout-metadata');
  if (receipt.refused !== undefined) {
    if (typeof receipt.refused !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(receipt.refused) || receipt.code === 0) throw runnerFailure(request, result, 'refusal-metadata');
    // The runner answered, so this is a named failure, not a dropped transport to requeue.
    throw new Refused('RUNNER_SETUP_REFUSED', `runner ${request.runner.host} refused this run before it started: [${receipt.refused}] from its own resource pool; run pullboard resources and pullboard settings on ${request.runner.host} to fix that pool, then run again`);
  }
  // The runner classified any file denial against its own checkout; only its evidence is trusted here.
  const sandboxBlocked = receipt.denial === undefined ? null : remoteFileDenial(receipt.denial, request.runner.host);
  if (receipt.denial !== undefined && (!sandboxBlocked || receipt.code === 0)) throw runnerFailure(request, result, 'denial-metadata');
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
    } catch { throw runnerFailure(request, result, 'private-phase-binding'); }
  } else if (receipt.trustedMode !== undefined) throw runnerFailure(request, result, 'unexpected-private-phases');
  const text = staged?.output ?? output.toString('utf8');
  if (receipt.environment !== undefined && environmentProblem(receipt.environment)) throw runnerFailure(request, result, 'environment-metadata');
  if (receipt.executionPhases !== undefined && !runnerPhaseFields(receipt.executionPhases)) throw runnerFailure(request, result, 'phase-metadata');
  if (receipt.sourcePreparation !== undefined && !sourcePreparationFields(receipt.sourcePreparation)) throw runnerFailure(request, result, 'source-preparation-metadata');
  if (receipt.testRuntimes != null && !testRuntimeRows(receipt.testRuntimes)) throw runnerFailure(request, result, 'test-runtime-metadata');
  if (receipt.browserRefused !== undefined && (receipt.browserRefused !== true || receipt.code === 0 || request.spec.browserRequired)) throw runnerFailure(request, result, 'browser-metadata');
  const admission = remoteAdmission(receipt.executionAdmission);
  if (request.spec.timing === true && (receipt.timing !== true || !admission)) throw runnerFailure(request, result, 'timing-admission');
  // Only the lease guard's own receipt counts; text a test prints is never a refusal (#1043).
  if (receipt.browserRefused === true) {
    const refused = new Refused('RUNNER_BROWSER_SLOT_REQUIRED', `runner ${request.runner.host} refused this run's lease for want of a browser slot (BROWSER_SLOT_REQUIRED)`);
    refused.runnerAttempt = { host: request.runner.host, exitCode: receipt.code, output: text };
    throw refused;
  }
  // A cache packet is considered only after the nonce, exact source, complete output and private
  // source guard have authenticated this completion. A dropped run imports no passing receipt.
  if (request.exchange && !receipt.signal && (!privateResult || privateResult.state === 'pass')) {
    importTestResults(request.exchange.store, receipt.testResults, request.spec.testResults.inputKeys);
  }
  return { isGreen: receipt.code === 0 && !receipt.signal, output: text, sandboxBlocked, ...(receipt.timedOut ? { timedOut: true } : {}),
    environment: receipt.environment ?? null, testRuntimes: receipt.testRuntimes ?? null, executionCapabilities: { gui: receipt.gui ?? null },
    ...(request.spec.stageMarker ? { stages: staged?.stages ?? null } : {}),
    seconds: Math.round(receipt.wallMs / 1000), exitCode: receipt.code,
    executionRunner: request.runner.host, executionRoot: receipt.root, remoteWallMs: receipt.wallMs,
    ...(receipt.executionPhases ? { executionPhases: runnerPhaseFields(receipt.executionPhases) } : {}),
    ...(receipt.sourcePreparation ? { sourcePreparation: sourcePreparationFields(receipt.sourcePreparation) } : {}),
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

/** Reconstruct the native transport outcome across a fresh controller process. */
function bridgeResult(request, result, phase) {
  let reply;
  try { reply = JSON.parse(result.stdout); }
  catch { throw runnerFailure({ runner: request.options.runner, args: [], phase }, result, 'bridge-json'); }
  if (reply.error?.name === 'Refused') {
    const prefix = `[${reply.error.code}] `;
    const refused = new Refused(reply.error.code, reply.error.message.startsWith(prefix) ? reply.error.message.slice(prefix.length) : reply.error.message);
    if (reply.error.runnerAttempt) refused.runnerAttempt = reply.error.runnerAttempt;
    throw refused;
  }
  if (reply.error?.name === 'RunnerDropped') throw new RunnerDropped(request.options.runner.host, reply.error.diagnostic);
  if (reply.error || result.error || result.status !== 0) throw runnerFailure({ runner: request.options.runner, args: [], phase }, result, 'bridge-exit');
  return reply.result;
}

/** Keep synchronous callers on the same fresh controller entry without a second bridge. */
export function runOnRunner(root, command, options) {
  const request = { root, command, options, parentPid: process.pid };
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/runner-controller.js', import.meta.url)), '--pullboard-runner-controller'], {
    cwd: root, input: JSON.stringify(request), encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES * 6 + 1024 ** 2,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return bridgeResult(request, child, 'sync-bridge');
}

/** Isolate asynchronous execution from dependencies cached before an installation upgrade. */
export async function runOnRunnerAsync(root, command, options) {
  if (options.signal?.aborted) throw new RunnerDropped(options.runner.host);
  // Preserve the stale-controller refusal; full provenance and transfer scans run once in the fresh process.
  loadedToolingFiles({ rescan: false });
  const { signal, ...plainOptions } = options;
  const request = { root, command, options: plainOptions, parentPid: process.pid };
  const input = JSON.stringify(request);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/runner-controller.js', import.meta.url)), '--pullboard-runner-controller'], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = [], diagnostics = [];
  let bytes = 0, error;
  // Budget: retain the synchronous bridge's worst-case JSON escaping limit, never an unbounded child response.
  const limit = MAX_OUTPUT_BYTES * 6 + 1024 ** 2;
  const abort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > limit) { error ??= new Error('runner bridge output exceeded its JSON limit'); abort(); }
    else output.push(chunk);
  });
  child.stderr.on('data', chunk => {
    diagnostics.push(chunk);
    if (diagnostics.reduce((sum, value) => sum + value.length, 0) > 8192) {
      const tail = Buffer.concat(diagnostics).subarray(-8192); diagnostics.splice(0, diagnostics.length, tail);
    }
  });
  child.on('error', caught => { error ??= caught; });
  child.stdin.on('error', caught => { error ??= caught; });
  child.stdin.end(input);
  try {
    const { status, signal: stopped } = await new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal })));
    return bridgeResult(request, { status, signal: stopped, error, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(diagnostics).toString('utf8') }, 'async-bridge');
  } finally { signal?.removeEventListener('abort', abort); }
}

/** Serve only a directly launched controller, whose dependency cache starts in this process. */
export async function serveRunnerController(ports) {
  if (typeof ports?.privateCheckEnvelope !== 'function' || typeof ports?.privateCheckPhases !== 'function') throw new TypeError('runner controller needs native private-check policy ports');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  const canceled = new AbortController();
  const abort = () => canceled.abort();
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, abort);
  process.stdout.on('error', abort);
  // Budget: notice loss of the exact originating controller once per second while SSH is active.
  const parentWatch = setInterval(() => { if (process.ppid !== request.parentPid) abort(); }, 1000);
  if (process.ppid !== request.parentPid) abort();
  try { process.stdout.write(JSON.stringify({ result: await runInController(request.root, request.command, { ...request.options, signal: canceled.signal }, ports) })); }
  catch (error) {
    process.stdout.write(JSON.stringify({ error: { name: error.name, code: error.code, message: error.message, host: error.host, runnerAttempt: error.runnerAttempt, diagnostic: error.diagnostic } }));
    process.exitCode = 1;
  } finally { clearInterval(parentWatch); }
}

/** Negotiate missing history objects while the remote cache lease stays held in one SSH session. */
async function runInController(root, command, options, ports) {
  if (options.signal?.aborted) throw new RunnerDropped(options.runner.host);
  const request = await requestFor(root, command, options, ports);
  let removeAbort = () => {};
  let runnerWaitTimer;
  let runnerWaitKill;
  let rawFd = null;
  try {
    if (request.rawOutputPath) rawFd = openSync(request.rawOutputPath, 'wx', 0o600);
    request.phase = 'connect';
    const child = spawn('ssh', request.args, { env: request.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], diagnostics = [];
    let bytes = 0, error, control = '', requested = false, transfer = null, cleanupReason = '';
    const rawHash = createHash('sha256');
    let rawBytes = 0, head = Buffer.alloc(0), tail = Buffer.alloc(0);
    const half = 4 * 1024 ** 2;
    const abort = () => { error ??= new Error('runner transport canceled'); child.stdin.destroy(); child.kill('SIGTERM'); };
    // Bound connection, worker admission and checkout, until READY immediately before execution.
    // An executing test keeps its existing test timeout and may outlive the runner wait.
    if (Number.isSafeInteger(options.runnerWaitDeadline)) runnerWaitTimer = setTimeout(() => {
      request.admissionDeadlineExceeded = true;
      abort();
      // Budget: a non-responsive SSH child cannot retain a local reservation forever.
      runnerWaitKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
    }, Math.max(0, options.runnerWaitDeadline - Date.now()));
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
        if (line === `PULLBOARD_RUNNER_READY ${request.spec.id}`) { request.phase = 'ready'; clearTimeout(runnerWaitTimer); }
        const cleanupPrefix = `PULLBOARD_RUNNER_CLEANUP_UNVERIFIED ${request.spec.id} `;
        if (line.startsWith(cleanupPrefix)) cleanupReason = line.slice(cleanupPrefix.length, cleanupPrefix.length + 240);
        if (line === `PULLBOARD_RUNNER_CLEANUP_TIMEOUT ${request.spec.id}`) {
          error = new Refused('RUNNER_CLEANUP_TIMEOUT', `runner ${request.runner.host} could not verify cleanup within 30 seconds${cleanupReason ? ': ' + cleanupReason : ''}; inspect job ${request.spec.id} under its runner namespace before another run`);
          error.diagnostic = runnerFailure(request, { status: null, stderr: '' }, 'cleanup-unverified').diagnostic;
          child.stdin.destroy(); child.kill('SIGTERM'); return;
        }
        const prefix = `PULLBOARD_RUNNER_NEED ${request.spec.id} `;
        if (!line.startsWith(prefix)) continue;
        if (requested) { error = new Error('duplicate runner inventory'); child.kill(); return; }
        requested = true; request.phase = 'inventory';
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
          request.phase = 'pack';
          const pack = historyPack(root, request.source, inventory.tips, request.directory, request.spec.tags, inventory.tagObjects);
          await pipeline(createReadStream(pack), child.stdin);
          if (request.phase !== 'ready') request.phase = 'source-sent';
        })().catch(failure => { error = failure; child.stdin.destroy(); child.kill(); });
      }
    });
    child.stdin.on('error', failure => { if (failure.code !== 'EPIPE') error ??= failure; });
    child.once('error', failure => { error = failure; });
    child.stdin.write(request.frame);
    const {status,signal} = await new Promise(resolve => child.once('close', (status,signal) => resolve({status,signal})));
    if (transfer) await transfer;
    if (error instanceof Refused) throw error;
    if (rawFd !== null) { closeSync(rawFd); rawFd = null; }
    const bounded = request.rawOutputPath ? Buffer.concat([head, ...(rawBytes > half * 2 ? [Buffer.from('\n[output capped at 8 MiB; middle omitted]\n')] : []), tail]) : Buffer.concat(output);
    return resultFrom(request, { status, signal, error, stdout: bounded, stderr: Buffer.concat(diagnostics),
      ...(request.rawOutputPath ? { rawOutputPath: request.rawOutputPath, rawBytes, rawSha256: rawHash.digest('hex') } : {}) }, ports);
  } finally { clearTimeout(runnerWaitTimer); clearTimeout(runnerWaitKill); if (rawFd !== null) closeSync(rawFd); removeAbort(); request.cleanup(); }
}

/** Give a pre-upgrade cached self-spawn caller a typed restart without reading input or starting transport. */
function refuseLegacyControllerEntry() {
  if (process.argv[2] !== '--pullboard-runner-controller' || !process.argv[1]) return;
  try { if (realpathSync(process.argv[1]) !== fileURLToPath(import.meta.url)) return; }
  catch { return; }
  process.stdout.write(JSON.stringify({ error: { name: 'Refused', code: 'RUNNER_TOOLING_CHANGED',
    message: 'runner controller entry changed; restart the command from the current committed CLI before retrying' } }));
  process.exitCode = 1;
}
refuseLegacyControllerEntry();

/** Ask the pinned worker for exact cleanup or an explicitly requested idle and writable proof. */
export async function probeRunnerHealth(runner, previous, { idle = false } = {}) {
  runner = validateRunner(runner);
  const { worker, tooling, runtime } = trustedTooling();
  const nonce = randomUUID();
  const request = { nonce, ...(idle ? { idle: true } : { previous }), ...(runner.root ? { root: runner.root } : {}) };
  const remote = remoteWorkerCommand(runner, worker, tooling, runtime,
    ' --health ' + shellWord(Buffer.from(JSON.stringify(request)).toString('base64')));
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=2', '--', runner.host, remote];
  const child = spawn('ssh', args, { env: sshEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', timedOut = false, error = null, kill;
  /** Bound the health connection and fully observe its close before releasing recovery ownership. */
  const stop = () => { child.kill('SIGTERM'); kill ??= setTimeout(() => child.kill('SIGKILL'), 500); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, 5_000);
  child.stdout.on('data', bytes => { output = (output + bytes).slice(0, 4097); if (output.length > 4096) stop(); });
  child.stderr.resume();
  child.once('error', failure => { error = failure.code ?? failure.name; });
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); clearTimeout(kill);
  let reply;
  try { reply = JSON.parse(output); } catch { /* Unknown or foreign replies do not attest health. */ }
  const workerReady = !error && !timedOut && result.code === 0 && !result.signal
    && reply?.version === 1 && reply.nonce === nonce && reply.worker === true;
  return { healthy: Boolean(workerReady && (idle ? reply.idle === true && reply.writable === true : reply.cleanup === true)),
    ...(idle ? { idle: workerReady && reply.idle === true, writable: workerReady && reply.writable === true } : {}),
    step: !workerReady ? 'worker readiness' : idle ? 'idle proof' : 'cleanup',
    reason: workerReady ? reply.reason : 'pinned worker did not answer health request', ...result, timedOut, error };
}

/** Supply canonical late-bound runner operations to an actual higher gate composition root. */
export function runnerExecutionServices() {
  return Object.freeze({ runOnRunner, runOnRunnerAsync, sampleRunnerLoad, localRunnerDescriptor,
    carriedRunnerTrunk, probeRunnerTransport, probeRunnerHealth });
}
