/** Each package's verdict is sealed to a content hash, and a change unseals exactly the packages whose hash it changes (RFC 0006 A1, A2) [C7,CD44]. */
import { fileSystemAdapter } from '../../../fs/index.js';
import { createHash } from 'node:crypto';
import {
  dirname,
  join,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gitSpawnSync } from '../../../git/index.js';
import { gitChildEnv } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { repositoryImport } from '../../../codemap/index.js';
import { Refused } from '../../../kernel/index.js';
import { importsIn } from '../../../codemap/index.js';
import { ownerOf } from './test/tiers.js';
import { cellOwners } from './test/tiers.js';

const fs = fileSystemAdapter();

const MODULE = /\.[cm]?js$/u;
// The committed cell plan and its shards declare which cell owns each legacy path.
const CELL_PLAN = /^packages\/codemap\/data\/plan(?:\.json|\/[^/]+\.json)$/u;
const SEAL_FILE = 'seals.sqlite';

/** Run one Git read at a fixed revision; a failure names the revision so the caller can fix it. */
function git(root, args, input) {
  const result = gitSpawnSync(args, { cwd: root, env: gitChildEnv(root), input, maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Refused('SEAL_REVISION', `git ${args[0]} failed: ${String(result.stderr ?? '').trim() || 'unknown error'}; name a commit that exists`);
  return result.stdout;
}

/** List every committed file at a revision with its blob id; blob ids are content addresses, so they match on any clone. */
function treeAt(root, rev) {
  const blobs = new Map();
  for (const line of git(root, ['ls-tree', '-r', '-z', '--full-tree', rev]).toString('utf8').split('\0')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/su.exec(line);
    if (match) blobs.set(match[2], match[1]);
  }
  return blobs;
}

/** Read the named blobs in one batch, keyed by blob id. */
function readBlobs(root, ids) {
  const texts = new Map();
  if (!ids.length) return texts;
  const out = git(root, ['cat-file', '--batch'], ids.join('\n') + '\n');
  let at = 0;
  for (const id of ids) {
    const end = out.indexOf(10, at);
    const size = Number(/ blob (\d+)$/u.exec(out.subarray(at, end).toString('utf8'))?.[1]);
    if (!Number.isSafeInteger(size)) throw new Refused('SEAL_REVISION', `blob ${id} could not be read; run git fsck`);
    texts.set(id, out.subarray(end + 1, end + 1 + size).toString('utf8'));
    at = end + 2 + size;
  }
  return texts;
}

/** Parse imports in one batch; a blob that does not compile imports nothing provable, while its own bytes still key its package. */
function importsOf(sources) {
  try { return importsIn(sources); }
  catch (error) {
    if (error.message !== 'source does not compile as an ES module') throw error;
    return sources.map(source => {
      try { return importsIn([source])[0]; }
      catch (failure) { if (failure.message !== 'source does not compile as an ES module') throw failure; return []; }
    });
  }
}

/**
 * Compute every package's sealed hash at each revision: its own files' blobs plus the blobs of the files outside it that
 * it imports (its front doors). One parse per distinct blob serves every revision, since unchanged files share blobs.
 *
 * @param {string} root
 * @param {string[]} revs
 * @returns {Map<string, { hash: string, files: string, doors: Map<string, string> }>[]} one map per revision
 */
export function packageHashesAt(root, revs) {
  const trees = revs.map(rev => treeAt(root, rev));
  const ids = [...new Set(trees.flatMap(tree => [...tree].filter(([file]) => MODULE.test(file) || file === 'package.json' || CELL_PLAN.test(file)).map(([, id]) => id)))].sort();
  const texts = readBlobs(root, ids);
  const jsIds = [...new Set(trees.flatMap(tree => [...tree].filter(([file]) => MODULE.test(file)).map(([, id]) => id)))].sort();
  const parsed = new Map();
  const all = importsOf(jsIds.map(id => texts.get(id)));
  jsIds.forEach((id, index) => parsed.set(id, all[index]));
  return trees.map(tree => {
    let imports = {};
    try { imports = JSON.parse(texts.get(tree.get('package.json')) ?? '{}').imports ?? {}; } catch { /* no import map */ }
    // Cells are read from this revision's committed plan, so a declared cell owns its legacy paths here.
    const declared = cellOwners({ get: path => (tree.has(path) ? Buffer.from(texts.get(tree.get(path)) ?? '') : undefined) });
    const owners = new Map(), owner = file => {
      if (!owners.has(file)) owners.set(file, ownerOf(file, tree, declared));
      return owners.get(file);
    };
    const rows = new Map();
    const row = name => rows.get(name) ?? rows.set(name, { lines: [], doors: new Map() }).get(name);
    for (const [file, id] of [...tree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const name = owner(file);
      if (name === null) continue;
      const own = row(name);
      own.lines.push(`F ${file} ${id}`);
      if (!MODULE.test(file)) continue;
      for (const specifier of parsed.get(id) ?? []) {
        const target = repositoryImport(file, specifier, imports);
        if (target && tree.has(target) && owner(target) !== name) own.doors.set(target, tree.get(target));
      }
    }
    const result = new Map();
    for (const [name, own] of [...rows].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const doors = new Map([...own.doors].sort(([a], [b]) => (a < b ? -1 : 1)));
      const files = createHash('sha256').update(own.lines.join('\n')).digest('hex');
      const hash = createHash('sha256').update(`${files}\n${[...doors].map(([file, id]) => `D ${file} ${id}`).join('\n')}`).digest('hex');
      result.set(name, { hash, files, doors });
    }
    return result;
  });
}

/**
 * The packages a change from base to head unseals, computed by comparing hashes, never by judging the diff.
 *
 * @param {string} root
 * @param {{ base: string, head?: string }} change
 * @returns {{ unsealed: { package: string, reason: string, hash: string | null }[], kept: string[], hashes: Map<string, string>, doors: string[] }}
 *   hashes holds each package's hash at head; doors lists the imported front doors whose bytes changed
 */
export function unsealedPackages(root, { base, head = 'HEAD' }) {
  const [before, after] = packageHashesAt(root, [base, head]);
  const unsealed = [], kept = [], doors = new Set();
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(name), now = after.get(name);
    for (const door of new Set([...(was?.doors.keys() ?? []), ...(now?.doors.keys() ?? [])])) {
      if (was?.doors.get(door) !== now?.doors.get(door) && was?.doors.has(door) && now?.doors.has(door)) doors.add(door);
    }
    if (was && now && was.hash === now.hash) { kept.push(name); continue; }
    let reason;
    if (!was) reason = 'added';
    else if (!now) reason = 'removed';
    else if (was.files !== now.files) reason = 'files';
    else reason = `front door ${[...new Set([...was.doors.keys(), ...now.doors.keys()])].filter(door => was.doors.get(door) !== now.doors.get(door)).join(', ')}`;
    unsealed.push({ package: name, reason, hash: now?.hash ?? null });
  }
  return { unsealed, kept, hashes: new Map([...after].map(([name, row]) => [name, row.hash])), doors: [...doors].sort() };
}

/** The seal store sits beside the board in the common Git directory, so every worktree shares one record. */
export function sealStoreFile(root) {
  const common = tryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { env: gitChildEnv(root) });
  if (common.status !== 0) throw new Refused('SEAL_STORE', 'seals need a Git repository; run this inside the project');
  return join(common.stdout, 'pullboard', SEAL_FILE);
}

/** Open the seal store, creating its one table on first use. */
function openSeals(file) {
  fs.mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS package_seal(package TEXT NOT NULL, hash TEXT NOT NULL, receipts TEXT NOT NULL, tests TEXT NOT NULL, sealed_at TEXT NOT NULL, PRIMARY KEY(package, hash))');
  return db;
}

/**
 * Record a package's green verdict at one hash with the receipts of the test runs that proved it.
 *
 * @param {string} file the seal store
 * @param {{ package: string, hash: string, receipts: string[], tests: string[], at?: string }} seal
 */
export function recordSeal(file, { package: name, hash, receipts, tests, at = new Date().toISOString() }) {
  if (typeof name !== 'string' || !/^[0-9a-f]{64}$/u.test(hash ?? '')) throw new Refused('SEAL_INVALID', 'a seal names a package and its 64-hex content hash; compute it with packageHashesAt');
  if (!Array.isArray(receipts) || !receipts.length || receipts.some(id => typeof id !== 'string' || !id)) {
    throw new Refused('SEAL_RECEIPTS', 'a seal needs the receipt ids of the green runs that proved it; run the package tests first');
  }
  const db = openSeals(file);
  try {
    db.prepare('INSERT INTO package_seal(package,hash,receipts,tests,sealed_at) VALUES (?,?,?,?,?) ON CONFLICT(package,hash) DO UPDATE SET receipts=excluded.receipts, tests=excluded.tests, sealed_at=excluded.sealed_at')
      .run(name, hash, JSON.stringify(receipts), JSON.stringify(tests ?? []), at);
  } finally { db.close(); }
}

/**
 * The verdict sealed for a package at exactly this hash, or null when none holds.
 *
 * @param {string} file
 * @param {string} name
 * @param {string} hash
 */
export function sealOf(file, name, hash) {
  const db = openSeals(file);
  try {
    const row = db.prepare('SELECT package, hash, receipts, tests, sealed_at FROM package_seal WHERE package=? AND hash=?').get(name, hash);
    return row ? { package: row.package, hash: row.hash, receipts: JSON.parse(row.receipts), tests: JSON.parse(row.tests), sealedAt: row.sealed_at } : null;
  } finally { db.close(); }
}

/**
 * Whether the store holds any seal at all.
 * Why: until the first seal exists, selection follows RFC 0006 A6 (touched packages only); after it, A3 applies and a
 * package with no current seal runs its tests.
 *
 * @param {string} file
 */
export function sealsExist(file) {
  if (!fs.exists(file)) return false;
  const db = openSeals(file);
  try { return Boolean(db.prepare('SELECT 1 FROM package_seal LIMIT 1').get()); } finally { db.close(); }
}

/**
 * Each package at a revision with its hash and the verdict sealed to it, if any.
 *
 * @param {string} root
 * @param {{ rev?: string, store?: string }} options
 */
export function sealStatus(root, { rev = 'HEAD', store = sealStoreFile(root) } = {}) {
  const [hashes] = packageHashesAt(root, [rev]);
  return [...hashes].map(([name, { hash }]) => ({ package: name, hash, seal: sealOf(store, name, hash) }));
}

/**
 * Refuse a selection that skips a package without a seal at its current hash, so skip logic can never report a false green.
 *
 * @param {string} root
 * @param {{ rev?: string, skipped: string[], store?: string }} options
 */
export function checkSkippedSeals(root, { rev = 'HEAD', skipped, store = sealStoreFile(root) }) {
  const [hashes] = packageHashesAt(root, [rev]);
  const broken = skipped.filter(name => !hashes.has(name) || !sealOf(store, name, hashes.get(name).hash)).sort();
  if (broken.length) throw new Refused('SEAL_STALE', `skipped without a seal at their current hash: ${broken.join(', ')}; run their tests`);
}

/**
 * Every package at a revision as sealed or unsealed; an unsealed one names the newest commit that changed its hash.
 * Why scan a window: the breaking change is the first commit, walking the first-parent line back from the revision, whose
 * first parent hashed the package differently (a side branch's commits are never adjacent pairs, so a merge is judged against its real parent); a change older than the window is reported as null rather than guessed.
 *
 * @param {string} root
 * @param {{ rev?: string, store?: string, depth?: number }} options
 * @returns {{ package: string, hash: string, sealed: boolean, receipts: string[], sealedAt: string | null, change: { commit: string, subject: string } | null }[]}
 */
export function sealedCells(root, { rev = 'HEAD', store = sealStoreFile(root), depth = 40 } = {}) {
  const rows = sealStatus(root, { rev, store });
  if (rows.every(row => row.seal)) return rows.map(row => ({ package: row.package, hash: row.hash, sealed: true, receipts: row.seal.receipts, sealedAt: row.seal.sealedAt, change: null }));
  const log = git(root, ['log', '--first-parent', `--max-count=${depth}`, '--format=%H%x09%s', rev]).toString('utf8').split('\n').filter(Boolean).map(line => line.split('\t'));
  const hashes = packageHashesAt(root, log.map(([commit]) => commit));
  return rows.map(row => {
    if (row.seal) return { package: row.package, hash: row.hash, sealed: true, receipts: row.seal.receipts, sealedAt: row.seal.sealedAt, change: null };
    const at = hashes.findIndex((_, index) => hashes[index + 1]?.get(row.package)?.hash !== row.hash);
    const found = at >= 0 && (at + 1 < log.length || log.length < depth) ? log[at] : null;
    return { package: row.package, hash: row.hash, sealed: false, receipts: [], sealedAt: null, change: found ? { commit: found[0], subject: found[1] ?? '' } : null };
  });
}
