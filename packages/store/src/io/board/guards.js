/** Install declared machine guards without confusing an approved old shape with manual drift [M3,A5,A6]. */
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { boardStanding } from "./migrate.js";
import { legacySigningMatchesStamp } from "./recovery.js";
import { guardsMatchStoredStamp } from "./migrate.js";
import { Refused } from "../../../../kernel/index.js";
import { recordSchemaStamp } from "./migrate.js";
import { SCHEMA_DIGEST } from "./schema/source.js";
import { SCHEMA_VERSION } from "./schema/source.js";
import { EVENT_LOG_VERSION } from "./schema/source.js";
import { SIGNED_EVENT_LOG_VERSION } from "./schema/source.js";
import { storeTriggers } from "../../../../state/index.js";

const GUARDED = 1;

/** Compare exact persistent guard SQL with the current machine declaration. */
function differences(db, wanted) {
  const have = new Map(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine%'")
    .all().map(row => [row.name, row.sql]));
  return {
    missing: wanted.filter(({ name }) => !have.has(name)).map(({ name }) => name),
    changed: wanted.filter(({ name, sql }) => have.has(name) && have.get(name) !== sql).map(({ name }) => name),
    stale: [...have.keys()].filter(name => !wanted.some(trigger => trigger.name === name)),
  };
}

/** A matching declaration needs neither a transaction nor a new guard event. */
function isWhole({ missing, changed, stale }) {
  return !missing.length && !changed.length && !stale.length;
}

/** Install missing or changed guards during a version migration, retaining its original audit evidence. */
export function guardStore(board) {
  const wanted = storeTriggers();
  if (isWhole(differences(board.db, wanted))) {
    if (board.db.prepare('PRAGMA user_version').get().user_version < SCHEMA_VERSION) board.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }
  atomic(board, () => {
    const found = differences(board.db, wanted);
    if (isWhole(found)) return;
    for (const name of [...found.changed, ...found.stale]) board.db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
    for (const { name, sql } of wanted) if (found.missing.includes(name) || found.changed.includes(name)) board.db.exec(sql);
    if (board.db.prepare('PRAGMA user_version').get().user_version >= GUARDED) logEvent(board, 'board', 'guards', null, found);
    if (board.db.prepare('PRAGMA user_version').get().user_version < SCHEMA_VERSION) board.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }, { reviewPolicy: false });
}

/**
 * Main may upgrade a valid old declaration or restore the exact guards attested by the stored stamp.
 * A missing guard or any additional table/index drift remains untouched, never approved by restamping.
 */
export function refreshStoreDeclarations(board) {
  const wanted = storeTriggers();
  const whole = isWhole(differences(board.db, wanted));
  if (whole && boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION) === 'current') return false;
  return atomic(board, () => {
    const standing = boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION);
    const recovery = standing === 'drifted' && guardsMatchStoredStamp(board.db, SCHEMA_DIGEST, wanted);
    const legacy = standing === 'drifted' && legacySigningMatchesStamp(board.db, SCHEMA_DIGEST, wanted);
    if (standing !== 'current' && !recovery && !legacy) return false;
    guardStore(board);
    if (!recovery || legacy) recordSchemaStamp(board.db, SCHEMA_DIGEST);
    if (legacy) logEvent(board, 'board', 'schema-signing-recovery', null, { prior: 'legacy-pin-or-signing', guards: 'exact', stamp: 'matched' });
    if (boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION) !== 'current') {
      throw new Refused('SCHEMA_DRIFT', 'the restored guards do not match the stored board stamp; keep the board and ask the coordinator to inspect its schema');
    }
    return true;
  }, { reviewPolicy: false });
}

/**
 * Called inside the restore transaction: verify and preserve the installed guards, never this caller's
 * declaration. Another connection may have upgraded the board since this connection was opened.
 */
export function suspendStoreGuards(board) {
  if (boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION) !== 'current') {
    throw new Refused('SCHEMA_DRIFT', 'cannot restore an unverified board shape; run pullboard inbox from the main checkout, then retry; preserve any remaining drift for the coordinator');
  }
  const shapeQuery = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
  const shape = JSON.stringify(board.db.prepare(shapeQuery).all());
  const installed = board.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_%' ORDER BY name").all();
  if (!isWhole(differences(board.db, storeTriggers()))) {
    const diagnostic = 'pullboard: preserving the installed trunk guards; this caller has a different declaration; update this CLI from main';
    if (board.onDiagnostic) board.onDiagnostic(diagnostic);
    else process.stderr.write(`${diagnostic}\n`);
  }
  for (const { name } of installed) board.db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  return () => {
    for (const { sql } of installed) board.db.exec(sql);
    const version = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='event_log_version'").get()?.meta_value;
    if (JSON.stringify(board.db.prepare(shapeQuery).all()) !== shape
      || ![String(EVENT_LOG_VERSION), String(SIGNED_EVENT_LOG_VERSION)].includes(version)) {
      throw new Refused('SCHEMA_DRIFT', 'restore changed the verified board shape or format; its transaction was rolled back; preserve the board and ask the coordinator to inspect it');
    }
    // Validated restore may change the signed-event format. The complete persistent SQL is unchanged.
    recordSchemaStamp(board.db, SCHEMA_DIGEST);
  };
}
