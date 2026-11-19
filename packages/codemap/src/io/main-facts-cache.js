/** Immutable derived facts live outside every checkout; never persist live board decisions. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { checkoutCommonDir } from '../../../git/index.js';
import { blobOid } from '../../../git/index.js';
import { cleanGitEnvironment } from '../../../git/index.js';
import { git } from '../../../git/index.js';
import { indexedFiles } from '../../../git/index.js';
import { mainCheckout } from '../../../git/index.js';
import { trunkRef } from '../../../git/index.js';
import { fileSystemAdapter } from '../../../fs/index.js';
import { environmentAdapter } from '../../../env/index.js';

const disk = fileSystemAdapter();
const environment = environmentAdapter();

const LIMIT = 64 * 1024 * 1024;
const DEFAULT_CACHE_BYTES = 512 * 1024 * 1024;
const DEFAULT_RECENT_COMMITS = 8;

/** Environment overrides are local cache limits, never board or proof authority. */
function cacheLimits() {
  const bytes = Number(environment.get('PULLBOARD_MAIN_FACTS_MAX_BYTES'));
  const recent = Number(environment.get('PULLBOARD_MAIN_FACTS_RECENT_COMMITS'));
  return { bytes: Number.isSafeInteger(bytes) && bytes >= 16384 ? bytes : DEFAULT_CACHE_BYTES,
    recent: Number.isSafeInteger(recent) && recent >= 1 && recent <= 1000 ? recent : DEFAULT_RECENT_COMMITS };
}

/** Keep all namespaces for one immutable commit together. */
function commitIdentity(identity) {
  const commit = Array.isArray(identity) ? identity[0] : identity && typeof identity === 'object' ? identity.commit : identity;
  return typeof commit === 'string' && commit ? commit : mainFactDigest(JSON.stringify(identity));
}
const TOOL_PATHS = ['package.json', 'src', 'bin', 'packages'];

/**
 * The same inventory taken from the git index: committed files by blob id, only changed or untracked ones read.
 * Null when the installation is not a plain git checkout, and the caller then walks it.
 */
function indexedToolIdentity(root) {
  const present = TOOL_PATHS.filter(name => disk.exists(join(root, name)));
  const found = indexedFiles(root, present);
  if (!found || found.links.size) return null;
  const entries = new Map(found.clean);
  for (const file of [...found.dirty, ...found.untracked]) {
    let stat;
    try { stat = disk.lstat(join(root, file)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) return null;
    entries.set(file, { mode: stat.mode & 0o111 ? '100755' : '100644', oid: blobOid(disk.readFile(join(root, file), null), found.length) });
  }
  const hash = createHash('sha256');
  for (const name of TOOL_PATHS) if (!present.includes(name)) hash.update(JSON.stringify([name, null]));
  for (const file of [...entries.keys()].sort()) hash.update(`${JSON.stringify([file, entries.get(file).mode, entries.get(file).oid])}\n`);
  return hash.digest('hex');
}

// Undefined until computed; null once the installation proved it cannot be fingerprinted, so no command walks it again.
let toolIdentity;

/** Bind facts to the complete shipped tool, including moved parser providers and grammar assets. */
export function mainFactToolIdentity() {
  if (toolIdentity === undefined) {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    try { toolIdentity = indexedToolIdentity(root) ?? undefined; } catch { toolIdentity = undefined; }
    if (toolIdentity !== undefined) return toolIdentity;
    const hash = createHash('sha256');
    let size = 0;
    let count = 0;
    /** Inventory the executing installation, even when its project owns a different package manifest. */
    function visit(file) {
      let stat;
      try { stat = disk.lstat(join(root, file)); }
      catch (error) { if (error.code === 'ENOENT') { hash.update(JSON.stringify([file, null])); return; } throw error; }
      if (stat.isSymbolicLink()) throw new Error('tool fingerprint cannot follow a symlink');
      if (stat.isDirectory()) {
        for (const name of disk.list(join(root, file)).sort()) visit(`${file}/${name}`);
      } else {
        if (!stat.isFile() || ++count > 20000 || (size += stat.size) > 128 * 1024 * 1024) throw new Error('tool fingerprint exceeds inventory bound');
        const bytes = disk.readFile(join(root, file), null);
        hash.update(JSON.stringify([file, bytes.length]) + '\n');
        hash.update(bytes);
      }
    }
    try { for (const file of ['package.json', 'src', 'bin', 'packages']) visit(file); }
    catch { toolIdentity = null; return null; }
    toolIdentity = hash.digest('hex');
  }
  return toolIdentity;
}

/** Identify exact semantic inputs, not their mutable filenames. */
export function mainFactDigest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Open private local derived data, refusing symlinked or non-private storage. */
function openCache(root, home) {
  // Git's files name the common directory without a launch; Git answers only when they cannot (#10823).
  const common = home ? null : checkoutCommonDir(root, { env: cleanGitEnvironment() }) ?? resolve(root, git(root, ['rev-parse', '--git-common-dir'], { env: cleanGitEnvironment() }));
  const directory = home ? join(home, 'main-facts') : join(common, 'pullboard-main-facts');
  disk.mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = disk.lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077) throw new Error('non-private main facts cache');
  const file = join(directory, 'facts.sqlite');
  try { disk.close(disk.open(file, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = disk.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error('non-private main facts database');
  // Loaded on first use: this module rides the codemap barrel every check script imports, and a static node:sqlite import prints a warning there.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=10000; PRAGMA auto_vacuum=FULL; CREATE TABLE IF NOT EXISTS facts(key TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, commit_id TEXT NOT NULL, touched INTEGER NOT NULL)');
    const columns = db.prepare('PRAGMA table_info(facts)').all().map(row => row.name);
    if (!columns.includes('commit_id') || !columns.includes('touched')) {
      // Old keys contain only a digest, so their original commits cannot be recovered safely.
      db.exec('BEGIN IMMEDIATE; DELETE FROM facts; ALTER TABLE facts ADD COLUMN commit_id TEXT; ALTER TABLE facts ADD COLUMN touched INTEGER; COMMIT');
    }
    if (db.prepare('PRAGMA auto_vacuum').get().auto_vacuum !== 1) {
      db.exec('PRAGMA auto_vacuum=FULL; VACUUM');
    }
    const page = db.prepare('PRAGMA page_size').get().page_size;
    const maximum = Math.max(1, Math.floor(cacheLimits().bytes / page));
    if (db.prepare('PRAGMA page_count').get().page_count > maximum) {
      db.exec('BEGIN IMMEDIATE; DELETE FROM facts; COMMIT; VACUUM');
      process.stderr.write('main facts cache evicted oversized cache entries\n');
    }
    db.exec(`PRAGMA max_page_count=${maximum}`);
  }
  catch (error) { try { db.close(); } catch { /* Preserve the setup failure. */ } throw error; }
  return db;
}

/**
 * Derive one validated JSON value under a separate single-flight transaction; damage is only a cache miss.
 * `home` is the caller's machine home: given, facts are kept machine-wide under it, so this cell never loads the resources door.
 */
export function cachedMainFact(root, namespace, identity, derive, validate, { home = null } = {}) {
  const key = mainFactDigest(JSON.stringify([1, namespace, identity]));
  const commit = commitIdentity(identity);
  let current = null;
  try {
    current = mainCheckout(root)?.commit ?? null;
    if (!current) {
      const trunk = trunkRef(root);
      if (trunk) current = git(root, ['rev-parse', '--verify', `${trunk}^{commit}`], { env: cleanGitEnvironment() }).trim();
    }
  } catch { /* Unavailable current-main metadata never blocks derivation. */ }
  let db;
  let derived;
  let derivationError;
  /** Build at most once in this call, including a failed publication. */
  function build() {
    if (derivationError) throw derivationError;
    if (derived === undefined) {
      try {
        const body = JSON.stringify(derive());
        if (typeof body !== 'string') throw new Error('main fact is not JSON');
        const value = JSON.parse(body);
        if (!validate(value)) throw new Error('invalid derived main fact');
        derived = body;
      } catch (error) { derivationError = error; throw error; }
    }
    return JSON.parse(derived);
  }
  try {
    db = openCache(root, home);
    db.exec('BEGIN IMMEDIATE');
    const saved = db.prepare('SELECT body,digest FROM facts WHERE key=?').get(key);
    if (saved && Buffer.byteLength(saved.body) <= LIMIT && mainFactDigest(saved.body) === saved.digest) {
      let value;
      try {
        const parsed = JSON.parse(saved.body);
        if (validate(parsed)) value = parsed;
      } catch { /* Invalid local data is rebuilt from committed source. */ }
      if (value !== undefined) { db.exec('COMMIT'); return value; }
    }
    const value = build();
    if (Buffer.byteLength(derived) <= LIMIT) {
      const { bytes, recent } = cacheLimits();
      const previous = db.prepare('SELECT commit_id, MAX(touched) AS touched FROM facts GROUP BY commit_id ORDER BY touched DESC').all();
      const keep = new Set([commit, ...(current ? [current] : []), ...previous.filter(row => row.commit_id !== commit && row.commit_id !== current).slice(0, Math.max(0, recent - (commit === current ? 0 : 1))).map(row => row.commit_id)]);
      let removed = 0;
      for (const row of previous) if (!keep.has(row.commit_id)) removed += db.prepare('DELETE FROM facts WHERE commit_id=?').run(row.commit_id).changes;
      const size = () => db.prepare('SELECT COALESCE(SUM(length(CAST(body AS BLOB)) + 256), 0) AS bytes FROM facts').get().bytes;
      for (const row of previous.toReversed()) {
        if (size() + Buffer.byteLength(derived) + 16384 <= bytes) break;
        if (row.commit_id !== current && row.commit_id !== commit) removed += db.prepare('DELETE FROM facts WHERE commit_id=?').run(row.commit_id).changes;
      }
      if (size() + Buffer.byteLength(derived) + 16384 <= bytes) {
        const touched = db.prepare('SELECT COALESCE(MAX(touched), 0) + 1 AS n FROM facts').get().n;
        db.prepare('INSERT OR REPLACE INTO facts(key,body,digest,commit_id,touched) VALUES (?,?,?,?,?)').run(key, derived, mainFactDigest(derived), commit, touched);
      }
      db.exec('COMMIT');
      if (removed) process.stderr.write(`main facts cache evicted ${removed} stale entries\n`);
      return value;
    }
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch { /* No transaction after an open failure. */ }
    return build();
  } finally { try { db?.close(); } catch { /* Cache cleanup cannot change derived fact semantics. */ } }
}
