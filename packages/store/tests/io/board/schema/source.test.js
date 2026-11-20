/** @pullboard-test-input source-cell store */
/** The board schema indexes the owner lookup the exit guard runs on every write, so it never scans the item table [C7,#10876]. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { closeBoard } from "../../../../index.js";
import { register } from "../../../../index.js";
import { openKitBoard } from "../../../fixtures/cell.js";
import { temporaryDirectory } from "../../../fixtures/tmp.js";

/** The exit guard's claimed-by-owner query exactly as requireExitActive runs it. */
const OWNER_LOOKUP = "SELECT item_id FROM item WHERE item_status = 'claimed' AND item_owner = ?";

test("store.io-board-schema-source.owner-status-index: clause 1: a board opened from the schema answers the claimed-by-owner lookup with an index search, not a scan of item [C7]", t => {
  const directory = temporaryDirectory("pullboard-owner-index-");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "board.sqlite");
  const board = openKitBoard(file);
  try { register(board, { lane: "coordinator", path: directory }); } finally { closeBoard(board); }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${OWNER_LOOKUP}`).all("someone").map(row => row.detail).join("\n");
    assert.match(plan, /SEARCH item USING (?:COVERING )?INDEX item_owner_status/u);
    assert.doesNotMatch(plan, /SCAN item/u);
  } finally { db.close(); }
});
