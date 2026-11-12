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

/**
 * The hit list a pulled gate or shard job carries: for each named file, its newest proof rows that passed under the
 * proof command with no fail at the same key, as `[file, inputKey, context index]` over a shared context list. The
 * runner reuses a file only when its own inputKey and context class match a row, so a stale or foreign row just
 * misses. Why by file: the job's runner computes the keys; the board only knows which files it will run [P7,CD2].
 * The rows fit `budget` bytes so the job request stays under the queue's cap; the rest are left out, so they run.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} files
 * @param {{ command?: string, perFile?: number, budget?: number }} [options]
 * @returns {{ contexts: string[], files: Array<[string, string, number]> } | null}
 */
export function ledgerHits(db, files, { command = 'proof', perFile = 2, budget = 24_000 } = {}) {
  if (missingLedgerTable(db) || !Array.isArray(files) || !files.length) return null;
  const select = db.prepare(`SELECT DISTINCT pass.test_result_input_key AS inputKey, pass.test_result_context AS context FROM test_result pass
    WHERE pass.test_result_file = ? AND pass.test_result_command = ? AND pass.test_result_status = 'pass'
      AND NOT EXISTS (SELECT 1 FROM test_result red WHERE red.test_result_input_key = pass.test_result_input_key AND red.test_result_command = pass.test_result_command
        AND red.test_result_context = pass.test_result_context AND red.test_result_file = pass.test_result_file AND red.test_result_status = 'fail')
    ORDER BY pass.test_result_id DESC LIMIT ?`);
  const contexts = [], rows = [];
  let bytes = 0;
  for (const file of [...new Set(files)].filter(file => FILE.test(String(file)))) {
    for (const { inputKey, context } of select.all(file, command, perFile)) {
      const index = contexts.includes(context) ? contexts.indexOf(context) : contexts.push(context) - 1;
      bytes += file.length + inputKey.length + 12;
      if (bytes > budget) return rows.length ? { contexts, files: rows } : null;
      rows.push([file, inputKey, index]);
    }
  }
  return rows.length ? { contexts, files: rows } : null;
}

/**
 * The test files the ledger holds proof rows for at any of `commits`, sorted: the plan a landing proves, read from the
 * board instead of a submit receipt or a live import graph. Why: one source of truth for what an item proved [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} commits
 * @param {{ command?: string }} [options]
 * @returns {string[]}
 */
export function ledgerFiles(db, commits, { command = 'proof' } = {}) {
  const wanted = [...new Set((commits ?? []).filter(commit => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(String(commit))))];
  if (missingLedgerTable(db) || !wanted.length) return [];
  const select = db.prepare('SELECT DISTINCT test_result_file AS file FROM test_result WHERE test_result_commit = ? AND test_result_command = ?');
  return [...new Set(wanted.flatMap(commit => select.all(commit, command).map(row => row.file)))].sort();
}
