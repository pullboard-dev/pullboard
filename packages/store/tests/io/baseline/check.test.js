/** @pullboard-test-input packages/store/src/io/baseline/check.js packages/store/src/logic/board/item/baseline.js */
/** A check baseline keeps its strict flag from the pending record to the completed one [C7]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Refused } from "../../../../kernel/index.js";
import { completeCheckBaseline } from "../../../src/io/baseline/check.js";
import { normalizeCheckBaseline } from "../../../src/io/baseline/check.js";
import { itemCheckBaseline } from "../../../src/logic/board/item/baseline.js";
import { cellBoard } from "../../fixtures/cell.js";
import { cellItem } from "../../fixtures/cell.js";

const MAIN = "a".repeat(40);
const REQUEST = "11111111-1111-4111-8111-111111111111";
const COMMAND = "check-strict";

/** An in-memory board with one item whose check awaits its baseline, pending with the given extra fields. */
function pendingItem(t, extra = {}) {
  const board = cellBoard(t, ":memory:");
  const pending = { command: COMMAND, main: MAIN, result: "pending", request: REQUEST, ...extra };
  const id = cellItem(board, { lane: "web", title: "Strict check", check: COMMAND, checkBaseline: pending }).item_id;
  return { board, id, pending };
}

test("store.io-baseline-check.strict-kept-on-pending: clause 1: normalizeCheckBaseline keeps strict: true on a pending baseline and refuses BAD_CHECK_BASELINE for a non-boolean strict [C7]", () => {
  const pending = { command: COMMAND, main: MAIN, result: "pending", request: REQUEST, strict: true };
  assert.equal(normalizeCheckBaseline("coordinator", COMMAND, pending).strict, true);
  for (const strict of ["yes", 1, null]) {
    assert.throws(() => normalizeCheckBaseline("coordinator", COMMAND, { ...pending, strict }), error => error instanceof Refused && error.code === "BAD_CHECK_BASELINE");
  }
});

test("store.io-baseline-check.strict-carried-to-completed: clause 2: completeCheckBaseline carries the pending record's strict onto the completed record, so itemCheckBaseline reads strict: true with its seconds [C7]", t => {
  const { board, id, pending } = pendingItem(t, { strict: true });
  assert.equal(completeCheckBaseline(board, id, { agentId: "coordinator", expected: pending, baseline: { command: COMMAND, main: MAIN, result: "red", seconds: 7 } }), true);
  const read = itemCheckBaseline(board, { item_id: id, item_check: COMMAND });
  assert.deepEqual([read.result, read.strict, read.seconds], ["red", true, 7]);
});

test("store.io-baseline-check.no-strict-unchanged: clause 3: a baseline without strict normalizes and completes exactly as today, with no strict field [C7]", t => {
  assert.equal(Object.hasOwn(normalizeCheckBaseline("coordinator", COMMAND, { command: COMMAND, main: MAIN, result: "red" }), "strict"), false);
  const { board, id, pending } = pendingItem(t);
  assert.equal(completeCheckBaseline(board, id, { agentId: "coordinator", expected: pending, baseline: { command: COMMAND, main: MAIN, result: "red", seconds: 3 } }), true);
  const read = itemCheckBaseline(board, { item_id: id, item_check: COMMAND });
  assert.equal(Object.hasOwn(read, "strict"), false);
  assert.deepEqual([read.result, read.seconds], ["red", 3]);
});
