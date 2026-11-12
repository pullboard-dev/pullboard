/** Scan the exact committed source and its history paths before any byte leaves the controller [C7]. */
import { configFromSource } from '../../../../config/index.js';
import { defaults } from '../../../../config/index.js';
import { cleanGitEnvironment } from '../../../../git/index.js';
import { blockedPaths } from '../../../../commits/index.js';
import { secretsIn } from '../../../../commits/index.js';
import { Refused } from '../../../../kernel/index.js';
import { gitSpawnSync } from '../../../../git/index.js';
import { loadKeyedResult } from '../keyed.js';
import { saveKeyedResult } from '../keyed.js';
import { fileURLToPath } from 'node:url';
import { closeSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { fstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { linkSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

export const MAX_BLOB_BYTES = 8 * 1024 ** 2;

/** Run a source-only Git read without inherited Git configuration, hooks or replacement objects. */
export function sourceGit(root, args, options = {}) {
  const result = gitSpawnSync(['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: MAX_BLOB_BYTES, ...options,
  });
  if (result.error?.code === 'ENOBUFS') {
    const directory = mkdtempSync(join(tmpdir(), 'pullboard-source-count-'));
    const fd = openSync(join(directory, 'stdout'), 'w+', 0o600);
    try {
      const counted = gitSpawnSync(['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: root, env: cleanGitEnvironment(), input: options.input, stdio: ['pipe', fd, 'pipe'], maxBuffer: MAX_BLOB_BYTES,
      });
      if (counted.status !== 0) throw new Refused('RUNNER_SOURCE', 'cannot read the exact committed source; check Git and retry the run');
      const bytes = fstatSync(fd).size;
      throw new Refused('RUNNER_SOURCE', `committed source scan produced ${bytes} bytes, exceeding its ${options.maxBuffer ?? MAX_BLOB_BYTES}-byte bound`);
    } finally { closeSync(fd); rmSync(directory, { recursive: true, force: true }); }
  }
  if (result.status !== 0) throw new Refused('RUNNER_SOURCE', 'cannot read the exact committed source; check Git and retry the run');
  return result.stdout;
}

/** The tooling export manifest a controller runs from; its tree names the scanner rules that made a verdict. */
/** The file name of that manifest; a runtime-written file, never part of the shipped closure. */
export const TOOLING_MANIFEST_NAME = '.pullboard-runner-source.json';
const TOOLING_MANIFEST = fileURLToPath(new URL(`../../../../../${TOOLING_MANIFEST_NAME}`, import.meta.url));
let toolingTree;

/**
 * The tree of the committed tooling this process runs, or null when it runs from no export. Why: a cached scan verdict
 * holds only for the rules that made it, and an export's tree names those rules exactly.
 */
export function scannerTree() {
  if (toolingTree === undefined) {
    try { toolingTree = JSON.parse(readFileSync(TOOLING_MANIFEST, 'utf8')).tree; } catch { toolingTree = null; }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(toolingTree ?? '')) toolingTree = null;
  }
  return toolingTree;
}

/**
 * Answer a clean scan from its saved verdict, or run it and save a clean answer. A verdict is keyed by the immutable
 * objects it read, the scanner's tooling tree and `parts`; a refusal is never saved, so it is thrown again by the scan.
 * Why: every runner dispatch rescanned every current blob and walked every tag with five Git calls each, about 4 s
 * when idle and far more at load, though one commit's answer never changes (9 Nov) [C7].
 *
 * @param {string} kind
 * @param {unknown[]} parts - What the verdict depends on beyond the scanner.
 * @param {() => any} scan - Returns a JSON value.
 * @returns {any}
 */
export function cachedScan(kind, parts, scan) {
  const tree = scannerTree();
  if (!tree) return scan();
  const folder = join(process.env.PULLBOARD_MACHINE_HOME || join(process.env.HOME || homedir(), '.pullboard'), 'source-scan');
  const key = JSON.stringify([kind, tree, ...parts]);
  let saved = keptScan(folder, key);
  if (saved) return saved.value;
  // One scan per key: the shards and the analysis trip of one gate prepare the same commit at once, and each scanned
  // it cold, 22-25 s apiece on the controller (11 Nov) [C7,#5728]. A waiter answers from the scanner's verdict; a
  // refusal is never kept, so after it each waiter scans and refuses for itself.
  const lock = join(folder, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.lock`);
  const release = takeScan(lock, () => (saved = keptScan(folder, key)) !== null);
  if (!release) return saved.value;
  try {
    saved = keptScan(folder, key);
    if (saved) return saved.value;
    const value = scan();
    try { saveKeyedResult(folder, key, Buffer.from(JSON.stringify({ key, value }))); }
    catch { /* An unwritable cache only costs the next scan its shortcut. */ }
    return value;
  } finally { release(); }
}

/** A kept clean verdict for this exact key, as { value }, or null; an unreadable verdict only costs the shortcut. */
function keptScan(folder, key) {
  try {
    const saved = loadKeyedResult(folder, key);
    if (saved) {
      const entry = JSON.parse(saved.toString('utf8'));
      if (entry?.key === key) return { value: entry.value };
    }
  } catch { /* An unreadable verdict only costs this scan its shortcut. */ }
  return null;
}

/** Scan every current blob and the commit message before any source bytes leave the controller; a clean commit's verdict is kept (cachedScan). */
export function sourceObjects(root, source) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.commit ?? '')) return scanSourceObjects(root, source);
  return cachedScan('source-objects', [source.commit, source.protect ?? null], () => scanSourceObjects(root, source));
}

/** Scan every current blob and the commit message before any source bytes leave the controller. */
function scanSourceObjects(root, source) {
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

/** How many clean commits the history verdict cache keeps per policy set. */
const CLEAN_HISTORY_KEEP = 16;

/** How long a history scan lock may stand before waiters treat its holder as stuck and scan themselves. */
const SCAN_LOCK_STALE_MS = 10 * 60_000;
/** How often a waiting caller looks for the scan holder's verdict. */
const SCAN_LOCK_POLL_MS = 50;

/**
 * The cache file of commits whose whole history passed these exact protection policies.
 * A commit id names its whole history, so a verdict holds in every clone that has the commit: the cache lives in the
 * machine's Pullboard home, shared by every tools folder and temporary clone, not in one repository's .git (#3682).
 * Why: each runner controller scanned from a fresh clone and missed the per-repository cache, so four jobs on a new
 * main each read all history at once. A shallow or grafted repository's history is cut short, so its verdict is kept
 * in that repository alone and never vouches for a full clone.
 */
function cleanHistoryFile(root, policies) {
  const common = sourceGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const digest = createHash('sha256').update(JSON.stringify(policies)).digest('hex').slice(0, 32);
  const partial = existsSync(join(common, 'shallow')) || existsSync(join(common, 'info', 'grafts'));
  const home = process.env.PULLBOARD_MACHINE_HOME || join(process.env.HOME || homedir(), '.pullboard');
  return join(partial ? join(common, 'pullboard') : home, 'history-scan', `${digest}.json`);
}

/** Read the cached clean commits, newest first; a missing or unreadable cache is empty. */
function cleanHistory(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value.filter(commit => /^[a-f0-9]{40,64}$/u.test(commit)) : [];
  } catch { return []; }
}

/**
 * Write `body` beside `file` under a unique name, creating the history-scan folder, and return that name; the caller
 * renames it into place, or links it as a lock. Every history-scan state file is written here, once.
 */
function staged(file, body) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, body, { mode: 0o600 });
  return temporary;
}

/** Replace a history-scan state file whole, so a reader never sees it half written. */
function record(file, body) {
  const temporary = staged(file, body);
  try { renameSync(temporary, file); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

/** Block this thread briefly; protectHistory is synchronous, so a waiter cannot yield. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether a scan lock's holder has exited or held it past any real scan, so a waiter may replace it. */
function staleScanLock(lock) {
  try {
    const { pid, at } = JSON.parse(readFileSync(lock, 'utf8'));
    if (!(Date.now() - at < SCAN_LOCK_STALE_MS)) return true;
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  } catch (error) { return error.code !== 'ENOENT'; }
}

/**
 * Become the one caller that scans this commit, or wait until that caller's verdict is written (#3682).
 * Returns a release function for the scanning caller, or null once `settled` reports a verdict. A lock that cannot be
 * written at all only costs the single flight: the caller scans unlocked, as before.
 *
 * @param {string} lock the lock path for this commit and policy set
 * @param {() => boolean} settled whether a verdict for the commit is already recorded
 * @returns {(() => void) | null}
 */
function takeScan(lock, settled) {
  for (;;) {
    if (settled()) return null;
    let pending = null;
    try {
      pending = staged(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
      // A hard link either creates the complete lock or fails because another caller holds it.
      linkSync(pending, lock);
      return () => rmSync(lock, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') return () => {};
    } finally { if (pending) rmSync(pending, { force: true }); }
    if (staleScanLock(lock)) rmSync(lock, { force: true });
    else pause(SCAN_LOCK_POLL_MS);
  }
}

/**
 * Apply current protection rules to all selected historical names before any anonymous cache seed.
 * History is immutable, so a commit whose whole history passed these exact policies stays clean: a later scan of a
 * descendant reads only `<clean>..<commit>`, and with no cached ancestor it reads all history. Why: the full scan ran
 * before every runner job and, three at once at load 20, left `whoami` taking 56 s (#3151). Concurrent callers for one
 * commit and policy set share one scan: the first holds a lock while it reads history, and the rest wait for its clean
 * verdict, or its blocked one, and answer from it (#3682).
 */
export function protectHistory(root, source, policies) {
  const file = cleanHistoryFile(root, policies);
  if (cleanHistory(file).includes(source.commit)) return;
  const blocked = `${file}.${source.commit}.blocked`;
  const refuse = () => new Refused('RUNNER_SECRET', 'selected history includes a blocked private path; keep this run local or remove that private history');
  const release = takeScan(`${file}.${source.commit}.lock`, () => existsSync(blocked) || cleanHistory(file).includes(source.commit));
  try {
    if (existsSync(blocked)) throw refuse();
    const clean = cleanHistory(file);
    if (clean.includes(source.commit)) return;
    const base = clean.find(commit => gitSpawnSync(['--no-replace-objects', 'merge-base', '--is-ancestor', commit, source.commit],
      { cwd: root, env: cleanGitEnvironment() }).status === 0);
    // Every historical path name, once per commit: this outgrew one blob's 8 MiB, so it gets its own bound.
    const paths = [...new Set(sourceGit(root, ['log', '--format=', '--name-only', '-z', '--no-renames', '--root', '-m', '--full-history',
      base ? `${base}..${source.commit}` : source.commit], { maxBuffer: 1 << 28 }).split('\0').filter(Boolean))];
    if (paths.some(path => policies.some(protect => protectedHistoryPath(path, protect)))) {
      // The blocked verdict is as immutable as the history: waiters, and later callers, refuse from it without a scan.
      try { record(blocked, ''); } catch { /* Waiters then scan and refuse for themselves. */ }
      throw refuse();
    }
    // A clean history makes each parent's history clean too. Proof commits are siblings on one main tip that no one
    // dispatched itself, so keeping the parents lets the next sibling scan only its own commit, not all history (#5550).
    let parents = [];
    try { parents = sourceGit(root, ['rev-parse', `${source.commit}^@`]).split('\n').filter(commit => /^[a-f0-9]{40,64}$/u.test(commit)); }
    catch { /* Without the parents only the commit itself is kept. */ }
    const fresh = [source.commit, ...parents];
    try { record(file, JSON.stringify([...fresh, ...cleanHistory(file).filter(commit => !fresh.includes(commit))].slice(0, CLEAN_HISTORY_KEEP))); }
    catch { /* An unwritable cache only costs the next scan its shortcut. */ }
  } finally { release?.(); }
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
