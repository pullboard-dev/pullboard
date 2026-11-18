/** The file lease refuses a leased busy file and lets a claim share a leased quiet file [C7,#1441]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quietFiles } from "../../index.js";
import { requireFileLease } from "../../index.js";

const NOW = "2026-11-18T12:00:00.000Z";

/** A board whose one live claim by another seat predicts the files its brief names. */
function boardWithHolder(file) {
  const holder = { item_id: 2, item_status: "claimed", item_owner: "seat-b", item_lease_until: "2026-11-18T13:00:00.000Z", item_brief: "Files:\n- " + file, item_criterion: "" };
  return { prepare: () => ({ all: () => [holder] }) };
}

/** The item being claimed, predicting one file. */
const claiming = (file) => ({ item_id: 1, item_brief: "Files:\n- " + file, item_criterion: "" });

test('items.lease.quiet-files-shared: clause 1: requireFileLease with a quiet set refuses FILE_LEASED for a leased busy file and lets the claim proceed on a leased quiet file [C7,#1441]', () => {
  const db = boardWithHolder("packages/items/src/a.js");
  const lease = { hubs: [] };
  const refused = (error) => error?.code === "FILE_LEASED";
  const quiet = new Set(quietFiles(["packages/items/src/a.js"], new Map(), 1));
  const busy = new Set(quietFiles(["packages/items/src/a.js"], new Map([["packages/items/src/a.js", 3]]), 1));
  assert.throws(() => requireFileLease(db, claiming("packages/items/src/a.js"), "seat-a", lease, NOW, busy), refused);
  assert.doesNotThrow(() => requireFileLease(db, claiming("packages/items/src/a.js"), "seat-a", lease, NOW, quiet));
  assert.throws(() => requireFileLease(db, claiming("packages/items/src/a.js"), "seat-a", lease, NOW), refused, "no quiet set keeps the old refusal");
});
