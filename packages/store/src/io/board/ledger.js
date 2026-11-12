/**
 * The proof ledger: one test_result row per test file a recorded run ran [P7,CD2].
 *
 * Key: the file, its inputKey (the per-file content key, packages/gate/src/io/test/action/cache.js), the command
 * class and the context class (a digest of node, platform, arch and declared environment). Value: pass or fail, the
 * receipt that proved it, and its origin. Why on the board: one source of truth for proof, read by every gate and
 * landing, never a per-machine file store. The table is an additive upgrade like the job tables: an existing board
 * gains it on its next owning open and restamps, so the schema digest and every older client stay valid.
 */

/** The table and its lookup index; IF NOT EXISTS keeps the statement safe on every open. */
export const LEDGER_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS test_result (
    test_result_id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_result_file TEXT NOT NULL,
    test_result_input_key TEXT NOT NULL,
    test_result_command TEXT NOT NULL,
    test_result_context TEXT NOT NULL,
    test_result_status TEXT NOT NULL,
    test_result_receipt TEXT NOT NULL,
    test_result_origin TEXT NOT NULL,
    test_result_commit TEXT,
    test_result_at INTEGER NOT NULL,
    UNIQUE (test_result_receipt, test_result_command, test_result_file)
  );
  CREATE INDEX IF NOT EXISTS test_result_key ON test_result (test_result_input_key, test_result_command, test_result_context);
`;

const HEX = /^[0-9a-f]{64}$/u;
const FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\n]{1,500}$/u;

/**
 * True when the ledger table is not installed yet.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function missingLedgerTable(db) {
  return !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_result'").get()
    || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='test_result_key'").get();
}

/**
 * Write one receipt's per-file results in one batch; a retried post of the same receipt writes nothing twice.
 * A board without the table (drifted or not yet upgraded) records nothing and says so by returning 0, since creating
 * a table outside the opener's restamp would drift the board.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ receipt: string, origin: string, commit?: string | null, at?: number,
 *   rows: Array<{ file: string, inputKey: string, command: string, context: string, status: 'pass' | 'fail' }> }} batch
 * @returns {number} how many rows were written
 */
export function recordTestResults(db, { receipt, origin, commit = null, at = Date.now(), rows }) {
  if (missingLedgerTable(db) || !Array.isArray(rows) || !rows.length) return 0;
  const valid = rows.filter(row => FILE.test(row?.file ?? '') && HEX.test(row.inputKey ?? '') && HEX.test(row.context ?? '')
    && typeof row.command === 'string' && row.command && (row.status === 'pass' || row.status === 'fail'));
  if (!valid.length) return 0;
  const insert = db.prepare(`INSERT OR IGNORE INTO test_result (test_result_file, test_result_input_key, test_result_command, test_result_context,
    test_result_status, test_result_receipt, test_result_origin, test_result_commit, test_result_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let written = 0;
  db.exec('SAVEPOINT test_result_batch');
  try {
    for (const row of valid) {
      written += Number(insert.run(row.file, row.inputKey, row.command, row.context, row.status, String(receipt), String(origin), commit, at).changes);
    }
    db.exec('RELEASE test_result_batch');
  } catch (error) {
    db.exec('ROLLBACK TO test_result_batch');
    db.exec('RELEASE test_result_batch');
    throw error;
  }
  return written;
}

/**
 * The ledger rows for one inputKey, or for one receipt, newest first.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ inputKey?: string, receipt?: string }} filter
 * @returns {Array<{ file: string, inputKey: string, command: string, context: string, status: string, receipt: string, origin: string, commit: string | null, at: number }>}
 */
export function testResults(db, { inputKey, receipt } = {}) {
  if (missingLedgerTable(db)) return [];
  const where = inputKey ? 'test_result_input_key = ?' : receipt ? 'test_result_receipt = ?' : '1 = 1';
  return db.prepare(`SELECT * FROM test_result WHERE ${where} ORDER BY test_result_id DESC`).all(...[inputKey ?? receipt].filter(Boolean)).map(row => ({
    file: row.test_result_file, inputKey: row.test_result_input_key, command: row.test_result_command, context: row.test_result_context,
    status: row.test_result_status, receipt: row.test_result_receipt, origin: row.test_result_origin, commit: row.test_result_commit, at: row.test_result_at }));
}
