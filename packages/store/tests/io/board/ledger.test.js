/** @pullboard-test-input source-cell store */
/** gateFailRows reads gate fail rows with the item, its files and the shard's runner time [C7]. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { gateFailRows } from "../../../index.js";
import { recordTestResults } from "../../../index.js";
import { LEDGER_SCHEMA_SQL } from "../../../index.js";
import { JOB_SCHEMA_SQL } from "../../../index.js";

const KEY = "1".repeat(64);
const CONTEXT = "2".repeat(64);

/** A small board: the ledger and job tables plus the two item columns the reader joins. */
function board() {
  const db = new DatabaseSync(":memory:");
  db.exec(LEDGER_SCHEMA_SQL);
  db.exec(JOB_SCHEMA_SQL);
  db.exec("CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_files TEXT)");
  db.prepare("INSERT INTO item (item_id, item_files) VALUES (?, ?)").run(7, "a.js\nb.js");
  return db;
}

const row = (file, status) => ({ file, inputKey: KEY, command: "proof", context: CONTEXT, status });
const step = (db, job, name, at) => db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_at) VALUES (?, ?, ?)").run(job, name, at);

test("store.board-ledger.fail-row-item-files-ms: clause 2: a gate fail row yields its item, files and ms [C7,#12059]", () => {
  const db = board();
  recordTestResults(db, { receipt: "gate:7:s1", origin: "gate", at: 500, rows: [row("x.test.js", "fail")] });
  step(db, "gate:7:s1", "claimed", 1000);
  step(db, "gate:7:s1", "receipt", 4500);
  assert.deepEqual(gateFailRows(db, { since: 0 }), [{ file: "x.test.js", item: 7, itemFiles: ["a.js", "b.js"], command: "proof", at: 500, ms: 3500 }]);
});

test("store.board-ledger.non-fail-rows-skipped: clause 2: a pass row, a non-gate receipt and a row before since yield nothing [C7,#12059]", () => {
  const db = board();
  recordTestResults(db, { receipt: "gate:7:s1", origin: "gate", at: 500, rows: [row("pass.test.js", "pass")] });
  recordTestResults(db, { receipt: "run:9", origin: "run", at: 500, rows: [row("run.test.js", "fail")] });
  recordTestResults(db, { receipt: "gate:7:s2", origin: "gate", at: 100, rows: [row("old.test.js", "fail")] });
  assert.deepEqual(gateFailRows(db, { since: 200 }), []);
});

test("store.board-ledger.no-claimed-step-ms-null: clause 2: a receipt job with no claimed step yields ms null [C7,#12059]", () => {
  const db = board();
  recordTestResults(db, { receipt: "gate:7:s1", origin: "gate", at: 500, rows: [row("x.test.js", "fail")] });
  step(db, "gate:7:s1", "receipt", 4500);
  assert.equal(gateFailRows(db, { since: 0 })[0].ms, null);
});
