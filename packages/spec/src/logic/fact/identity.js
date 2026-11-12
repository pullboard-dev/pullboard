/** Indexed global fact identities, including supported legacy JSON5 and SQLite JSONB [B29,C7]. */
import { Refused } from '../../../../kernel/light.js';

const warnedUnknown = new WeakSet();

/** Accept only the two physical history partitions when constructing additive index names. */
function indexNames(table) {
  if (!['event', 'event_archive'].includes(table)) throw new TypeError('fact identity indexes require an event table');
  return { identity: `${table}_fact_identity_v2`, malformed: `${table}_fact_malformed_v2`, unknown: `${table}_fact_unknown_v2` };
}

/** Index readable identities and bounded error/unknown sentinels without parsing malformed rows. */
export function factIdentityIndexSql(table) {
  const names = indexNames(table);
  return `CREATE INDEX IF NOT EXISTS ${names.identity} ON ${table} (json_extract(event_detail, '$.id'), event_id)
      WHERE event_kind = 'fact' AND json_valid(event_detail, 10);
    CREATE INDEX IF NOT EXISTS ${names.malformed} ON ${table} (event_id)
      WHERE event_kind = 'fact' AND typeof(event_detail) = 'text' AND NOT json_valid(event_detail, 10);
    CREATE INDEX IF NOT EXISTS ${names.unknown} ON ${table} (event_id)
      WHERE event_kind = 'fact' AND typeof(event_detail) <> 'text' AND NOT json_valid(event_detail, 10);`;
}

/** List physical partitions in the original history lookup's hot-then-cold order. */
function factTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('event', 'event_archive') ORDER BY name")
    .all().map(({ name }) => name);
}

/** Old strict-JSON indexes never satisfy the current legacy-compatible readiness requirement. */
export function missingFactIdentityIndexes(db) {
  return factTables(db).filter((table) => {
    const names = indexNames(table);
    return db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name IN (?, ?, ?)")
      .get(table, names.identity, names.malformed, names.unknown).n !== 3;
  });
}

/** Install additive indexes only through the owning writable opener's existing atomic restamp. */
export function ensureFactIdentityIndexes(db) {
  for (const table of missingFactIdentityIndexes(db)) db.exec(factIdentityIndexSql(table));
}

/** Refuse indexless appends without hidden nonowner DDL or a per-append history scan. */
export function requireFactIdentityIndexes(db) {
  if (missingFactIdentityIndexes(db).length) {
    throw new Refused('FACT_INDEX_NOT_READY', 'fact identity indexes are missing; have the owning main checkout open this board once, then retry the original move');
  }
}

/**
 * Seek identities globally, retaining the original malformed-TEXT versus duplicate precedence.
 * Unsupported corrupt non-TEXT history has unknown identity and one diagnostic per connection;
 * native writers emit JSON text, and valid legacy JSON text BLOBs/JSONB remain indexed normally.
 */
export function factIdentityExists(db, id, { onDiagnostic = console.warn } = {}) {
  requireFactIdentityIndexes(db);
  for (const table of factTables(db)) {
    const names = indexNames(table);
    const unknown = db.prepare(`SELECT 1 FROM ${table} INDEXED BY ${names.unknown}
      WHERE event_kind = 'fact' AND typeof(event_detail) <> 'text' AND NOT json_valid(event_detail, 10) LIMIT 1`).get();
    if (unknown && !warnedUnknown.has(db)) {
      warnedUnknown.add(db);
      onDiagnostic('[FACT_ID_UNKNOWN] unsupported corrupt non-text fact history has an unknown identity; its stored event is unchanged');
    }
    const match = db.prepare(`SELECT CAST(event_id AS TEXT) AS event_id FROM ${table} INDEXED BY ${names.identity}
      WHERE event_kind = 'fact' AND json_valid(event_detail, 10) AND json_extract(event_detail, '$.id') = ?
      ORDER BY ${table}.event_id LIMIT 1`).get(id);
    const malformed = db.prepare(`SELECT CAST(event_id AS TEXT) AS event_id FROM ${table} INDEXED BY ${names.malformed}
      WHERE event_kind = 'fact' AND typeof(event_detail) = 'text' AND NOT json_valid(event_detail, 10)
      ORDER BY ${table}.event_id LIMIT 1`).get();
    if (malformed && (!match || BigInt(malformed.event_id) < BigInt(match.event_id))) {
      db.prepare(`SELECT json_extract(event_detail, '$.id') FROM ${table} WHERE event_id = ?`).get(malformed.event_id);
      throw new Error('malformed-text fact sentinel unexpectedly parsed; preserve the board and inspect its indexes');
    }
    if (match) return true;
  }
  return false;
}
