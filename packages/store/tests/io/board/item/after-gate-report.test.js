/** A claim of an after-gate dependent records one note on it naming the parent, its head and the claim time [C7,#12325]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordSubmitHandoff } from "../../../../../jobs/index.js";
import { setAfterGate } from "../../../../src/io/board/item/after-gate.js";
import { getItem } from "../../../../index.js";
import { itemThread } from "../../../../index.js";
import { fixture } from "../../../fixtures/dispatch.js";

/** The after-gate claim notes on one item's thread. */
function claimNotes(board, id) {
  return itemThread(board, id).filter(entry => entry.type === "fact" && entry.kind === "note" && String(entry.text).startsWith("after-gate claim:"));
}

/** A board with a gate-green parent submitted at a real head, and the seat that claims. */
function seeded(t) {
  const box = fixture(t);
  const parent = box.add("Green parent");
  box.submit(parent);
  const head = getItem(box.board, parent).item_commit;
  recordSubmitHandoff(box.board.db, parent, { id: `fixture-${parent}`, commit: head, agentId: box.seats.builder.id, state: "green" });
  return { box, parent, head };
}

test("store.io-board-item-after-gate-report.claim-recorded: clause 1: claiming a dependent whose after-gate parent is gate-green records one note fact starting after-gate claim: naming the parent id, the parent head and the claim time, and a plain --after claim and a renewed claim record none [C7,#12325]", t => {
  const { box, parent, head } = seeded(t);
  const child = box.add("Dependent on the gate");
  setAfterGate(box.board, child, [parent]);
  box.claim(child);
  const notes = claimNotes(box.board, child);
  assert.equal(notes.length, 1, "one note for the claim");
  assert.ok(notes[0].text.includes(`#${parent}`), "names the parent id");
  assert.ok(notes[0].text.includes(head), "names the parent head");
  assert.ok(notes[0].text.includes(box.clock.now().toISOString()), "names the claim time");
  box.claim(child);
  assert.equal(claimNotes(box.board, child).length, 1, "a renewed claim records none");
  const plain = box.add("Item with no after-gate parent");
  box.claim(plain);
  assert.equal(claimNotes(box.board, plain).length, 0, "a claim with no after-gate parent records none");
});
