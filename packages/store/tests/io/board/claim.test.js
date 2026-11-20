/** A claim of a dependent accepts a gate-green after-gate parent and records the parent head as its base [C7,#11800]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addItem } from "../../../index.js";
import { claim } from "../../../index.js";
import { recordSubmitHandoff } from "../../../../jobs/index.js";
import { setAfterGate } from "../../../src/io/board/item/after-gate.js";
import { readBoardMeta } from "../../../src/io/board/meta.js";
import { cellBoard } from "../../fixtures/cell.js";
import { cellProject } from "../../fixtures/cell.js";
import { cellSeat } from "../../fixtures/cell.js";

const BRIEF = "Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n";
const FREEZE = item => ({ text: item.item_title, digest: `digest:${item.item_title}` });
const HOUR = 60 * 60 * 1000;
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

/** A board with a coordinator and a web seat, and an `add` that files one open item. */
function seeded(t) {
  const project = cellProject(t, { real: true, gate: "true" });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: "coordinator", path: project.repo });
  const seat = cellSeat(board, { lane: "web", path: "/claim-seat", route: "strong" });
  const add = (title, extra = {}) => addItem(board, { by: "coordinator", lane: "web", title, route: "mid", criterion: "The private fixture proves the claim.", brief: BRIEF, check: "true", ...extra });
  /** The parent is submitted at HEAD with a gate record in the given state, recorded for a head the gate ran at. */
  const submitParent = (title, job, { jobHead = HEAD } = {}) => {
    const parent = add(title);
    board.db.prepare("UPDATE item SET item_status='submitted', item_commit=? WHERE item_id=?").run(HEAD, parent);
    recordSubmitHandoff(board.db, parent, { id: `fixture-${parent}`, commit: jobHead, agentId: seat.id, ...job });
    return parent;
  };
  const take = id => claim(board, id, { agentId: seat.id, lane: "web", leaseMs: HOUR, freeze: FREEZE });
  return { board, add, submitParent, take };
}

test("store.io-board-claim.after-gate-green-parent-claims: clause 1: claiming a dependent whose after-gate parent is submitted with a green gate at its submitted head is accepted and records the parent id and head under after_gate_base [C7,#11800]", t => {
  const { board, add, submitParent, take } = seeded(t);
  const parent = submitParent("Green parent", { state: "green" });
  const child = add("Dependent on the gate");
  setAfterGate(board, child, [parent]);
  take(child);
  assert.deepEqual(JSON.parse(readBoardMeta(board.db, `after_gate_base:${child}`)), { parent, head: HEAD });
});

test("store.io-board-claim.not-green-or-plain-after-refuses: clause 2: a claim whose after-gate parent has a red, running or stale-head gate, and a claim whose plain --after parent is only submitted, are each refused BLOCKED [C7,#11800]", t => {
  const { board, add, submitParent, take } = seeded(t);
  const cases = [
    submitParent("Red parent", { state: "red", error: { code: "TEST_FAILURE" } }),
    submitParent("Running parent", { state: "running" }),
    submitParent("Stale-head parent", { state: "green" }, { jobHead: OTHER }),
  ];
  for (const parent of cases) {
    const child = add(`Dependent on #${parent}`);
    setAfterGate(board, child, [parent]);
    assert.throws(() => take(child), error => error.code === "BLOCKED", `after-gate parent #${parent} is not green at its head`);
  }
  const plain = submitParent("Green plain parent", { state: "green" });
  const dependent = add("Plain after dependent", { after: [plain] });
  assert.throws(() => take(dependent), error => error.code === "BLOCKED", "a plain --after parent that is only submitted still refuses");
});
