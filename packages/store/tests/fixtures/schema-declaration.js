import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The schema-declaration journeys' shared setup, so the slow carry case can live in its own file. The caller hands it the pieces
 * of the state, store and runners cells it uses, so this fixture imports no other cell [C7].
 */
export function createSchemaFixture({ MACHINE, storeTriggers, SCHEMA_DIGEST, SCHEMA_VERSION, boardStanding, recordSchemaStamp, copyPackageFiles }) {
  /** Open the board file the way the store does: a live pulled gate job writes it, so a raw handle waits out a lock instead of failing at once [C7]. */
  function openRawBoard(file, options = {}) {
    const db = new DatabaseSync(file, options);
    db.exec('PRAGMA busy_timeout = 30000');
    return db;
  }

  /** Install and stamp the real previous declaration in a private fixture, without changing its data version. */
  function olderDeclaration(file, stamp = true) {
    const db = openRawBoard(file);
    try {
      const old = storeTriggers({ ...MACHINE, moves: MACHINE.moves.filter(move => move.verb !== 'submit-merge') })
        .find(trigger => trigger.name === 'machine_item_move');
      assert.ok(!old.sql.includes("'claimed>verified'"));
      db.exec(`DROP TRIGGER machine_item_move; ${old.sql}`);
      if (stamp) recordSchemaStamp(db, SCHEMA_DIGEST);
    } finally { db.close(); }
  }

  /** Read persistent shape and native evidence without invoking a writable opener. */
  function observe(file) {
    const db = openRawBoard(file, { readOnly: true });
    try {
      return {
        standing: boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION),
        version: db.prepare('PRAGMA user_version').get().user_version,
        stamp: db.prepare('PRAGMA application_id').get().application_id,
        schema: db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        identity: db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value,
        items: db.prepare('SELECT * FROM item ORDER BY item_id').all(),
        guards: db.prepare("SELECT event_detail FROM event WHERE event_kind='guards' ORDER BY event_id").all(),
      };
    } finally { db.close(); }
  }

  /**
   * Make a genuine private main source checkout of the candidate: its files in a fresh repository whose own Git directory is the
   * common one, which is all main authority reads. It holds no commit: hashing and committing the whole tree cost seconds a loaded
   * runner multiplied, and this journey's 180 s per-file budget was spent there [C7].
   */
  function privateMainSource(box, directory) {
    copyPackageFiles(resolve(import.meta.dirname, '../../../..'), directory);
    box.git(directory, 'init', '-q', '-b', 'main');
  }
  return { openRawBoard, olderDeclaration, observe, privateMainSource };
}
