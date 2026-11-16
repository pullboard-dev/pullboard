/** The event_archive table, where events of long-verified items can move out of the hot event table [C7]. */

/** Its CREATE statements, each IF NOT EXISTS, shared by the full schema and the additive upgrade of an older board. */
export const EVENT_ARCHIVE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS event_archive (
    event_id INTEGER PRIMARY KEY,
    event_at TEXT NOT NULL,
    event_by TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    item_id INTEGER,
    event_detail TEXT NOT NULL DEFAULT '{}',
    event_archived_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS event_archive_item_id_event_id ON event_archive (item_id, event_id);
`;

/** True when the archive table is not installed on this board. */
export function missingEventArchive(db) {
  return !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'event_archive'").get();
}
