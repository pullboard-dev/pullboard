/** A claim of a dependent accepts a gate-green after-gate parent and records the parent head as its base [C7,#11800]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordSubmitHandoff } from "../../../../jobs/index.js";
import { setAfterGate } from "../../../src/io/board/item/after-gate.js";
import { readBoardMeta } from "../../../src/io/board/meta.js";
import { getItem } from "../../../index.js";
import { fixture } from "../../fixtures/dispatch.js";

const OTHER = "b".repeat(40);

/** A board whose builder seat claims; `submitParent` publishes a parent at a real head and records its gate in the given state. */
function seeded(t) {
  const box = fixture(t);
  const submitParent = (title, job, { jobHead } = {}) => {
    const parent = box.add(title);
    box.submit(parent);
    const head = getItem(box.board, parent).item_commit;
    recordSubmitHandoff(box.board.db, parent, { id: `fixture-${parent}`, commit: jobHead ?? head, agentId: box.seats.builder.id, ...job });
    return { parent, head };
  };
  return { board: box.board, add: box.add, submitParent, take: box.claim };
}

test("store.io-board-claim.after-gate-green-parent-claims: clause 1: claiming a dependent whose after-gate parent is submitted with a green gate at its submitted head is accepted and records the parent id and head under after_gate_base [C7,#11800]", t => {
  const { board, add, submitParent, take } = seeded(t);
  const { parent, head } = submitParent("Green parent", { state: "green" });
  const child = add("Dependent on the gate");
  setAfterGate(board, child, [parent]);
  take(child);
  assert.deepEqual(JSON.parse(readBoardMeta(board.db, `after_gate_base:${child}`)), { parent, head });
});

test("store.io-board-claim.not-green-or-plain-after-refuses: clause 2: a claim whose after-gate parent has a red, running or stale-head gate, and a claim whose plain --after parent is only submitted, are each refused BLOCKED [C7,#11800]", t => {
  const { board, add, submitParent, take } = seeded(t);
  const cases = [
    submitParent("Red parent", { state: "red", error: { code: "TEST_FAILURE" } }).parent,
    submitParent("Running parent", { state: "running" }).parent,
    submitParent("Stale-head parent", { state: "green" }, { jobHead: OTHER }).parent,
  ];
  for (const parent of cases) {
    const child = add(`Dependent on #${parent}`);
    setAfterGate(board, child, [parent]);
    assert.throws(() => take(child), error => error.code === "BLOCKED", `after-gate parent #${parent} is not green at its head`);
  }
  const { parent: plain } = submitParent("Green plain parent", { state: "green" });
  const dependent = add("Plain after dependent", { after: [plain] });
  assert.throws(() => take(dependent), error => error.code === "BLOCKED", "a plain --after parent that is only submitted still refuses");
});
