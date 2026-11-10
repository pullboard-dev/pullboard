/** Keep the cold event-format migration separate from normal board moves [C7]. */
import {
  EVENT_LOG_VERSION,
  SCHEMA,
} from "../../schema/source.js";
import { readEventLogVersion } from "../../read/snapshot.js";
/** Refuse future event records and update older formats inside the owning open's atomic migration. */
export function migrateEventLogVersion(db) {
  db.exec(SCHEMA);
  const version = readEventLogVersion(db);
  if (version < EVENT_LOG_VERSION) {
    db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
      .run('event_log_version', String(EVENT_LOG_VERSION));
  }
}

