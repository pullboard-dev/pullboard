/** Scan the exact committed source and its history paths before any byte leaves the controller [C7]. */
import { configFromSource } from './config.js';
import { defaults } from './config.js';
import { cleanGitEnvironment } from './git.js';
import { blockedPaths } from './hooks.js';
import { secretsIn } from './hooks.js';
import { Refused } from './refused.js';
import { spawnSync } from 'node:child_process';
import { closeSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MAX_BLOB_BYTES = 8 * 1024 ** 2;

/** Run a source-only Git read without inherited Git configuration, hooks or replacement objects. */
export function sourceGit(root, args, options = {}) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: MAX_BLOB_BYTES, ...options,
  });
  if (result.status !== 0) throw new Refused('RUNNER_SOURCE', 'cannot read the exact committed source; check Git and retry the run');
  return result.stdout;
}

/** Scan every current blob and the commit message before any source bytes leave the controller. */
export function sourceObjects(root, source) {
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
export function protectedHistoryPath(path, protect) {
  return blockedPaths([path], protect).length || /(?:^|\/)board\.sqlite(?:-(?:wal|shm))?$/u.test(path);
}

/** Read admitted protection rules from its immutable commit, retaining non-board defaults. */
export function protectionAt(root, commit) {
  const record = sourceGit(root, ['ls-tree', '-z', commit, '--', 'pullboard.json']);
  const object = record.match(/^\d+ blob ([a-f0-9]{40,64})\t/u)?.[1];
  return object ? configFromSource(sourceGit(root, ['cat-file', 'blob', object])).protect : defaults().protect;
}

/** Apply current protection rules to all selected historical names before any anonymous cache seed. */
export function protectHistory(root, source, policies) {
  const paths = [...new Set(sourceGit(root, ['log', '--format=', '--name-only', '-z', '--no-renames', '--root', '-m', '--full-history', source.commit])
    .split('\0').filter(Boolean))];
  if (paths.some(path => policies.some(protect => protectedHistoryPath(path, protect)))) {
    throw new Refused('RUNNER_SECRET', 'selected history includes a blocked private path; keep this run local or remove that private history');
  }
}

/** Read one exact cat-file record without loading a repository's history into memory. */
export function objectRecord(descriptor) {
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
