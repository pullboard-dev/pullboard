/** Machine-wide store of real V8 compile results, keyed by source bytes, so a change re-parses only its own files [C7]. */
import { createHash } from 'node:crypto';
import { fileSystemAdapter } from '../../../fs/index.js';
const disk = fileSystemAdapter();
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { machineHome } from '../../../kernel/index.js';

const MAX_ROWS = 400_000;
/** Keys per lookup query; far under SQLite's variable limit. */
const LOOKUP_BATCH = 500;

/** The directory every checkout and runner job on this machine shares; tests isolate it with their account home and no shared cache. */
function storeDirectory() {
  // A runner job's HOME is new each job, so its jobs share their runner's cache instead (PULLBOARD_RUNNER_SHARED_CACHE, #8233).
  const shared = process.env.PULLBOARD_RUNNER_SHARED_CACHE;
  if (shared && isAbsolute(shared)) return join(shared, 'parse-cache');
  const override = process.env.PULLBOARD_MACHINE_HOME, accountHome = process.env.PULLBOARD_ACCOUNT_HOME;
  const home = machineHome({ override, accountHome, osHome: override || accountHome ? undefined : userInfo().homedir });
  return join(home, 'parse-cache');
}

/** Digest of one source under one parser epoch; the epoch pins runtime, flags and parser program. */
function keyOf(epoch, source) {
  return createHash('sha256').update(epoch).update('\0').update(source).digest('hex');
}

/** A compile result is exactly a boolean and a list of strings; anything else is a miss. */
function validRow(row) {
  return row && typeof row.compiles === 'boolean' && Array.isArray(row.imports) && row.imports.every(value => typeof value === 'string');
}

/** Open the private store, creating it on first use; null when the machine cannot supply one. */
function openStore() {
  try {
    const directory = storeDirectory();
    disk.mkdir(directory, { recursive: true, mode: 0o700 });
    // Loaded on first use: codemap's door is imported by every check script, and node:sqlite prints a warning when loaded [C7].
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(join(directory, 'parse-results.sqlite'));
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; CREATE TABLE IF NOT EXISTS results(key TEXT PRIMARY KEY, body TEXT NOT NULL)');
      return db;
    } catch (error) { try { db.close(); } catch { /* Keep the setup failure. */ } throw error; }
  } catch { return null; }
}

/**
 * Compile results for `sources`, taking every one the store already holds and asking `compile` for the rest only.
 * A damaged or unreachable store is a cache miss, never a different answer.
 *
 * @param {string} epoch Everything that could change what V8 reports for the same bytes.
 * @param {string[]} sources
 * @param {(missing: string[]) => { compiles: boolean, imports: string[] }[]} compile
 * @returns {{ compiles: boolean, imports: string[] }[]}
 */
export function storedCompilations(epoch, sources, compile) {
  const db = openStore();
  if (!db) return compile(sources);
  try {
    const keys = sources.map(source => keyOf(epoch, source));
    const found = new Map();
    // One query per batch of keys, not one per key: a cold trip looked up thousands one by one, ~0.9 s (#8242).
    try {
      const wanted = [...new Set(keys)];
      for (let at = 0; at < wanted.length; at += LOOKUP_BATCH) {
        const batch = wanted.slice(at, at + LOOKUP_BATCH);
        for (const saved of db.prepare(`SELECT key, body FROM results WHERE key IN (${batch.map(() => '?').join(',')})`).all(...batch)) {
          try { const row = JSON.parse(saved.body); if (validRow(row)) found.set(saved.key, row); } catch { /* Rebuilt below. */ }
        }
      }
    } catch { found.clear(); }
    const missing = [...new Map(sources.map((source, index) => [keys[index], source])).entries()].filter(([key]) => !found.has(key));
    const compiled = missing.length ? compile(missing.map(([, source]) => source)) : [];
    if (missing.length) {
      missing.forEach(([key], index) => found.set(key, compiled[index]));
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
        if (db.prepare('SELECT COUNT(*) AS n FROM results').get().n > MAX_ROWS) db.exec('DELETE FROM results');
        const write = db.prepare('INSERT OR REPLACE INTO results(key, body) VALUES (?, ?)');
          missing.forEach(([key], index) => {
            if (validRow(compiled[index])) write.run(key, JSON.stringify(compiled[index]));
          });
          db.exec('COMMIT');
        } catch { try { db.exec('ROLLBACK'); } catch { /* No transaction. */ } }
      } catch { /* A storage failure must not replace the real compiler result. */ }
    }
    return keys.map(key => found.get(key));
  }
  finally { try { db.close(); } catch { /* Closing cannot change a result. */ } }
}
