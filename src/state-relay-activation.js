/** Additive activation-witness index; native receipts and their engine meaning stay unchanged [E21,H16,C7]. */
import { AGENT_GRANT_ENGINE } from './agent-grant-engine.js';

export const GRANT_ACTIVATION_INDEX = 'board_meta_grant_activation_v2';
const UNSAFE_INDEX = 'board_meta_grant_activation_unsafe_v1';
const RECEIPTS = "meta_key GLOB 'relay_receipt_*'";
// Guard the outer envelope before extracting its nested move: either layer can be malformed.
const READABLE = `CASE WHEN json_valid(meta_value, 10) THEN
  CASE WHEN json_extract(meta_value, '$.move') IS NULL OR json_valid(json_extract(meta_value, '$.move'), 10)
    THEN 1 ELSE 0 END ELSE 0 END`;
const ENGINE = `CASE WHEN (${READABLE}) THEN json_extract(json_extract(meta_value, '$.move'), '$.engine') END`;
const SEQUENCE = "CASE WHEN json_valid(meta_value, 10) THEN json_extract(meta_value, '$.sequence') END";
const QUALIFIED = `(${ENGINE}) >= ${AGENT_GRANT_ENGINE}`;
let warnedMissingIndex = false;

/** Owning writable opens install the derived index once, including on already-current boards. */
export function missingGrantActivationIndex(db) {
  return db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='board_meta' AND name IN (?,?)")
    .get(GRANT_ACTIVATION_INDEX, UNSAFE_INDEX).n !== 2;
}

/** Index only qualifying engines by sequence, so future receipts cannot become a growing filter scan. */
export function ensureGrantActivationIndex(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS ${GRANT_ACTIVATION_INDEX} ON board_meta (
    ${SEQUENCE}
  ) WHERE ${RECEIPTS} AND ${QUALIFIED};
  CREATE INDEX IF NOT EXISTS ${UNSAFE_INDEX} ON board_meta (meta_key)
    WHERE ${RECEIPTS} AND (${READABLE}) = 0`);
}

/** Retain the literal historical predicate, including its malformed-data errors and short circuit. */
function legacyActivation(db, sequence) {
  return Boolean(db.prepare(`SELECT 1 FROM board_meta WHERE meta_key GLOB 'relay_receipt_*'
    AND json_extract(meta_value, '$.sequence') <= ?
    AND json_extract(json_extract(meta_value, '$.move'), '$.engine') >= ? LIMIT 1`)
    .get(sequence, AGENT_GRANT_ENGINE));
}

/** Seek a witness inside the applied prefix; corrupt legacy receipts retain their original behavior. */
export function recordedGrantActivation(board) {
  const db = board.db;
  const cursor = db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('relay_applied_sequence');
  const sequence = cursor ? Number(cursor.meta_value) : 0;
  if (!Number.isSafeInteger(sequence) || sequence < 1) return false;
  if (missingGrantActivationIndex(db)) {
    if (!warnedMissingIndex) {
      warnedMissingIndex = true;
      console.warn('[RELAY_ACTIVATION_INDEX_MISSING] activation uses the slower legacy query; open this board once from its owning main checkout to install the index');
    }
    return legacyActivation(db, sequence);
  }
  const unsafe = db.prepare(`SELECT 1 FROM board_meta INDEXED BY ${UNSAFE_INDEX}
    WHERE ${RECEIPTS} AND (${READABLE}) = 0 LIMIT 1`).get();
  // Only unsafe historical data takes this unbounded compatibility path; ordinary receipts never scan it.
  if (unsafe) return legacyActivation(db, sequence);
  return Boolean(db.prepare(`SELECT 1 FROM board_meta INDEXED BY ${GRANT_ACTIVATION_INDEX}
    WHERE ${RECEIPTS} AND ${QUALIFIED} AND (${SEQUENCE}) <= ? LIMIT 1`)
    .get(sequence));
}
