/** Immutable derived facts live outside every checkout; never persist live board decisions. */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { closeSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { git } from './git.js';
import { cleanGitEnvironment } from './git.js';
import { Refused } from './refused.js';

const LIMIT = 64 * 1024 * 1024;
let toolIdentity;

/** Bind facts to the complete shipped tool, including moved parser providers and grammar assets. */
export function mainFactToolIdentity() {
  if (!toolIdentity) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const hash = createHash('sha256');
    let size = 0;
    let count = 0;
    /** Inventory the executing installation, even when its project owns a different package manifest. */
    function visit(file) {
      let stat;
      try { stat = lstatSync(join(root, file)); }
      catch (error) { if (error.code === 'ENOENT') { hash.update(JSON.stringify([file, null])); return; } throw error; }
      if (stat.isSymbolicLink()) throw new Error('tool fingerprint cannot follow a symlink');
      if (stat.isDirectory()) {
        for (const name of readdirSync(join(root, file)).sort()) visit(`${file}/${name}`);
      } else {
        if (!stat.isFile() || ++count > 20000 || (size += stat.size) > 128 * 1024 * 1024) throw new Error('tool fingerprint exceeds inventory bound');
        const bytes = readFileSync(join(root, file));
        hash.update(JSON.stringify([file, bytes.length]) + '\n');
        hash.update(bytes);
      }
    }
    try { for (const file of ['package.json', 'src', 'bin', 'packages']) visit(file); }
    catch { return null; }
    toolIdentity = hash.digest('hex');
  }
  return toolIdentity;
}

/** Identify exact semantic inputs, not their mutable filenames. */
export function mainFactDigest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Open private local derived data, refusing symlinked or non-private storage. */
function openCache(root) {
  const common = resolve(root, git(root, ['rev-parse', '--git-common-dir'], { env: cleanGitEnvironment() }));
  const directory = join(common, 'pullboard-main-facts');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077) throw new Error('non-private main facts cache');
  const file = join(directory, 'facts.sqlite');
  try { closeSync(openSync(file, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error('non-private main facts database');
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS facts(key TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL)'); }
  catch (error) { try { db.close(); } catch { /* Preserve the setup failure. */ } throw error; }
  return db;
}

/** Derive one validated JSON value under a separate single-flight transaction; damage is only a cache miss. */
export function cachedMainFact(root, namespace, identity, derive, validate) {
  const key = mainFactDigest(JSON.stringify([1, namespace, identity]));
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
    db = openCache(root);
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
    if (Buffer.byteLength(derived) <= LIMIT) db.prepare('INSERT OR REPLACE INTO facts VALUES (?,?,?)').run(key, derived, mainFactDigest(derived));
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch { /* No transaction after an open failure. */ }
    if (error?.code === 'MAIN_FACTS_BUSY') throw error;
    if ([5, 6].includes((error?.errcode ?? 0) & 0xff) || ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error?.code)
      || /database (?:is )?(?:locked|busy)/iu.test(error?.message ?? '')) {
      throw new Refused('MAIN_FACTS_BUSY', 'immutable main facts are still being derived by another process; wait for that derivation to finish, then retry');
    }
    return build();
  } finally { try { db?.close(); } catch { /* Cache cleanup cannot change derived fact semantics. */ } }
}
