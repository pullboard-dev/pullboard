/** @pullboard-test-input source-cell store */
/** The test ledger has a commit index so the landing offer reads main reds and proof files by seek, not a scan [C7,#11191]. */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { closeBoard } from "../../../index.js";
import { ledgerFiles } from "../../../index.js";
import { ledgerMainReds } from "../../../index.js";
import { recordTestResults } from "../../../index.js";
import { missingAdditiveSchema } from "../../../src/io/board/indexes.js";
import { openKitBoard } from "../../fixtures/cell.js";
import { temporaryDirectory } from "../../fixtures/tmp.js";

const MAIN = "a".repeat(40);
const OTHER = "b".repeat(40);
const KEY = "1".repeat(64);
const CONTEXT = "2".repeat(64);
const INDEX = "test_result_commit_file";
const MAIN_REDS = `SELECT DISTINCT test_result_input_key AS inputKey, test_result_context AS context FROM test_result
    WHERE test_result_file = ? AND test_result_commit = ? AND test_result_command = ? AND test_result_status = 'fail'`;
const FILES = "SELECT DISTINCT test_result_file AS file FROM test_result WHERE test_result_commit = ? AND test_result_command = ?";

/** A real board file in a temporary folder, seeded with proof rows at two commits. */
function seededBoard(t) {
  const directory = temporaryDirectory("pullboard-ledger-commit-index-");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "board.sqlite");
  const board = openKitBoard(file);
  try {
    const row = (name, status) => ({ file: name, inputKey: KEY, command: "proof", context: CONTEXT, status });
    recordTestResults(board.db, { receipt: "r1", origin: "gate", commit: MAIN, rows: [row("a.test.js", "fail"), row("b.test.js", "pass")] });
    recordTestResults(board.db, { receipt: "r2", origin: "gate", commit: OTHER, rows: [row("a.test.js", "pass"), row("c.test.js", "fail")] });
  } finally { closeBoard(board); }
  return file;
}

/** Run work on a plain read-only connection, as sqlite3 on the live board would. */
function readOnly(file, work) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return work(db); } finally { db.close(); }
}

/** The plan detail lines of one statement. */
function plan(db, sql, ...args) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail).join("\n");
}

/** The two lookups' answers through the store's own functions. */
function answers(file) {
  return readOnly(file, db => ({ reds: ledgerMainReds(db, ["a.test.js", "b.test.js", "c.test.js"], MAIN, []), files: ledgerFiles(db, [MAIN, OTHER]) }));
}

/** Drop the commit index, as a board made before it would lack it. */
function dropIndex(file) {
  const db = new DatabaseSync(file);
  try { db.exec(`DROP INDEX ${INDEX}`); } finally { db.close(); }
}

test("store.ledger.main-reds-indexed: clause 1: the ledgerMainReds and ledgerFiles statements seek test_result_commit_file [C7,#11191]", t => {
  const file = seededBoard(t);
  readOnly(file, db => {
    assert.match(plan(db, MAIN_REDS, "a.test.js", MAIN, "proof"), /SEARCH test_result USING (?:COVERING )?INDEX test_result_commit_file/u);
    assert.match(plan(db, FILES, MAIN, "proof"), /SEARCH test_result USING (?:COVERING )?INDEX test_result_commit_file/u);
  });
});

test("store.ledger.main-reds-unchanged: clause 1: both lookups return the same rows with the index and without it [C7,#11191]", t => {
  const file = seededBoard(t);
  const withIndex = answers(file);
  dropIndex(file);
  assert.deepEqual(withIndex, answers(file));
  assert.deepEqual(withIndex.reds, [["a.test.js", KEY, 0]]);
  assert.deepEqual(withIndex.files, ["a.test.js", "b.test.js", "c.test.js"]);
});

test("store.ledger.commit-index-upgrade: clause 2: a board without the index reports missingAdditiveSchema and gains it on its next owning open, keeping every row [C7,#11191]", t => {
  const file = seededBoard(t);
  dropIndex(file);
  const probe = () => readOnly(file, db => ({
    missing: Boolean(missingAdditiveSchema(db)),
    index: Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX)),
    rows: db.prepare("SELECT count(*) AS n FROM test_result").get().n,
  }));
  assert.deepEqual(probe(), { missing: true, index: false, rows: 4 });
  closeBoard(openKitBoard(file));
  assert.deepEqual(probe(), { missing: false, index: true, rows: 4 });
});
