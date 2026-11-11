/** Recognize only prior full-shape stamps from legacy normal pin/sign operations [M3,E22,H16]. */
import { AUTHORITY } from "../../logic/board/authority.js";
import { AUTHORITY_TRIGGERS } from "../../logic/board/authority.js";
import { EVENT_LOG_VERSION } from "./schema/source.js";
import { SIGNED_EVENT_LOG_VERSION } from "./schema/source.js";
import { priorShapeMatchesStoredStamp } from "./migrate.js";

/** A local pin is only a syntactic migration prerequisite; it never establishes relay trust. */
function validPin(value) {
  try {
    const pin = JSON.parse(value);
    return typeof pin?.origin === 'string' && pin.origin.length > 0
      && typeof pin.publicKey === 'string' && /^[A-Za-z0-9_-]{40,200}$/u.test(pin.publicKey);
  } catch { return false; }
}

/** Only normal ordered signing history permits projecting the permanent signed format back to its prior value. */
function signingHistory(db) {
  const rows = db.prepare("SELECT event_detail FROM event WHERE event_kind='person_signing' ORDER BY event_id").all();
  if (!rows.length) return false;
  try {
    const details = rows.map(row => JSON.parse(row.event_detail));
    return details[0]?.signed === true && details.every(detail => typeof detail?.signed === 'boolean');
  } catch { return false; }
}

/**
 * Old pin/sign APIs added three guards or raised format without updating the stamp. Reconstruct only
 * those exact additive histories, retaining every other schema object and requiring the complete old hash.
 */
export function legacySigningMatchesStamp(db, digest, guards) {
  const installed = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_%'").all();
  if (installed.length !== guards.length || installed.some(row => !guards.some(guard => guard.name === row.name))) return false;
  const authority = db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'person_authority_%'").all();
  const pin = db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(AUTHORITY);
  const pinned = Boolean(pin);
  if (pinned) {
    if (!validPin(pin.meta_value) || authority.length !== AUTHORITY_TRIGGERS.length
      || AUTHORITY_TRIGGERS.some(guard => !authority.some(row => row.name === guard.name
        && row.sql === guard.sql.replace('CREATE TRIGGER IF NOT EXISTS ', 'CREATE TRIGGER ')))) return false;
  } else if (authority.length) return false;
  const version = db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='event_log_version'").get()?.meta_value;
  const history = signingHistory(db);
  if (version !== String(history ? SIGNED_EVENT_LOG_VERSION : EVENT_LOG_VERSION)) return false;
  const omissions = pinned ? [[], AUTHORITY_TRIGGERS.map(guard => guard.name)] : [[]];
  const versions = history ? [version, String(EVENT_LOG_VERSION)] : [version];
  for (const omitTriggers of omissions) for (const eventLogVersion of versions) {
    if (!omitTriggers.length && eventLogVersion === version) continue;
    for (const machine of [null, guards]) {
      if (priorShapeMatchesStoredStamp(db, digest, machine, { omitTriggers, eventLogVersion })) return true;
    }
  }
  return false;
}
