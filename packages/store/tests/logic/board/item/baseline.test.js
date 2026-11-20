/** @pullboard-test-input packages/store/src/logic/board/item/baseline.js */
/** remeasureCandidates picks the open items whose check lacks a timed, non-strict baseline, within the free runner slots [C7]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { remeasureCandidates } from "../../../../src/logic/board/item/baseline.js";
import { cellBoard } from "../../../fixtures/cell.js";
import { cellItem } from "../../../fixtures/cell.js";

const MAIN = "a".repeat(40);
const REQUEST = "11111111-1111-4111-8111-111111111111";

/** Add an open item whose check is its own command, with an optional baseline record on top of that command. */
function addItem(board, name, baseline) {
  const command = `check-${name}`;
  return cellItem(board, { lane: "web", title: name, check: command, ...(baseline ? { checkBaseline: { command, main: MAIN, ...baseline } } : {}) }).item_id;
}

test("store.logic-board-item-baseline.remeasure-candidates: clause 1: remeasureCandidates(board, { slots }) returns the open items whose check has no baseline or one with no seconds, that are not pending and not strict, oldest first [C7]", t => {
  const board = cellBoard(t, ":memory:");
  const none = addItem(board, "none");
  const untimed = addItem(board, "untimed", { result: "red" });
  addItem(board, "timed", { result: "green", seconds: 4 });
  addItem(board, "pending", { result: "pending", request: REQUEST });
  addItem(board, "strict", { result: "red", strict: true });
  const later = addItem(board, "later", { result: "red", strict: false });
  assert.deepEqual(remeasureCandidates(board, { slots: 10 }).map(item => item.item_id), [none, untimed, later]);
});

test("store.logic-board-item-baseline.remeasure-slots: clause 2: it returns at most slots minus the pending baselines, and none when that is zero or less [C7]", t => {
  const board = cellBoard(t, ":memory:");
  const ids = ["a", "b", "c", "d"].map(name => addItem(board, name));
  assert.deepEqual(remeasureCandidates(board, { slots: 2 }).map(item => item.item_id), ids.slice(0, 2));
  addItem(board, "inflight", { result: "pending", request: REQUEST });
  assert.deepEqual(remeasureCandidates(board, { slots: 2 }).map(item => item.item_id), ids.slice(0, 1));
  assert.deepEqual(remeasureCandidates(board, { slots: 1 }), []);
  assert.deepEqual(remeasureCandidates(board, { slots: 0 }), []);
  assert.deepEqual(remeasureCandidates(board, { slots: -3 }), []);
});
