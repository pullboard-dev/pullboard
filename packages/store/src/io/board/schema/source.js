/** Shared literal schema/version inputs; both openers validate the same declaration [C7]. */
import { schemaDigest } from "../migrate.js";
import { EVENT_ARCHIVE_SCHEMA_SQL } from "./archive.js";

/** Version of the persisted append-only event record format; bump for incompatible format changes. */
export const EVENT_LOG_VERSION = 1;
/** Signed-person history requires tools that understand its authority stamps [E22]. */
export const SIGNED_EVENT_LOG_VERSION = 2;

/** Maximum time a board connection waits for another process to release SQLite's lock; defined with the read-only opener that uses it. */
export { BOARD_BUSY_TIMEOUT_MS } from "../read/light.js";

/** The board's PRAGMA user_version once its triggers are in: losing one after that is news. */
export const SCHEMA_VERSION = 3;

/**
 * The oldest board schema this release upgrades: the one the release before it ships [R4].
 * Why: support is one release back, so an older board is refused untouched instead of being
 * walked up in one silent step that rewrote review levels.
 */
export const OLDEST_UPGRADABLE_SCHEMA = 3;

/** The one next step for a board from before the oldest upgradable release, shared by the refusal and doctor [R4]. */
export const BOARD_TOO_OLD_NEXT = 'open this board with pullboard 0.9.3 first, then open it with this version';

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS board_meta (
    meta_key TEXT PRIMARY KEY,
    meta_value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent (
    agent_id TEXT PRIMARY KEY,
    agent_lane TEXT NOT NULL,
    agent_path TEXT NOT NULL UNIQUE,
    agent_last_shout_id INTEGER NOT NULL DEFAULT 0,
    agent_route TEXT NOT NULL DEFAULT 'strong',
    agent_family TEXT,
    agent_created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS item (
    item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_parent_id INTEGER REFERENCES item (item_id),
    item_lane TEXT NOT NULL,
    item_title TEXT NOT NULL,
    item_criterion TEXT NOT NULL DEFAULT '',
    item_spec_ids TEXT NOT NULL DEFAULT '',
    item_after TEXT NOT NULL DEFAULT '',
    item_brief TEXT NOT NULL DEFAULT '',
    item_route TEXT NOT NULL DEFAULT 'strong',
    item_check TEXT NOT NULL DEFAULT '',
    item_status TEXT NOT NULL DEFAULT 'open',
    item_owner TEXT,
    item_lease_until TEXT,
    item_frozen TEXT,
    item_frozen_digest TEXT,
    item_built_by TEXT,
    item_builder_family TEXT,
    item_commit TEXT,
    item_tree TEXT,
    item_verdict TEXT,
    item_verified_by TEXT,
    item_merged_commit TEXT,
    item_withdrawn_reason TEXT,
    item_hold_reason TEXT,
    item_hold_by TEXT,
    item_hold_at TEXT,
    item_created_by TEXT NOT NULL,
    item_created_at TEXT NOT NULL,
    item_updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS item_lane_status ON item (item_lane, item_status);
  CREATE TABLE IF NOT EXISTS verdict (
    verdict_id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES item (item_id),
    verdict_by TEXT NOT NULL,
    verdict_verifier_family TEXT,
    verdict_decision TEXT NOT NULL,
    verdict_reason TEXT NOT NULL,
    verdict_note TEXT NOT NULL DEFAULT '',
    verdict_commit TEXT NOT NULL,
    verdict_digest TEXT NOT NULL,
    verdict_head TEXT NOT NULL,
    verdict_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS verdict_item_id_verdict_id ON verdict (item_id, verdict_id);
  CREATE TABLE IF NOT EXISTS shout (
    shout_id INTEGER PRIMARY KEY AUTOINCREMENT,
    shout_from TEXT NOT NULL,
    shout_to TEXT NOT NULL,
    shout_text TEXT NOT NULL,
    shout_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS event (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_at TEXT NOT NULL,
    event_by TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    item_id INTEGER,
    event_detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS event_item_id_event_id ON event (item_id, event_id);
  ${EVENT_ARCHIVE_SCHEMA_SQL}
  CREATE TABLE IF NOT EXISTS hold (
    hold_lane TEXT PRIMARY KEY,
    hold_reason TEXT NOT NULL,
    hold_by TEXT NOT NULL,
    hold_at TEXT NOT NULL
  );
`;

/** This code's schema digest, shared unchanged by read and write opens. */
export const SCHEMA_DIGEST = schemaDigest(SCHEMA, EVENT_LOG_VERSION);
