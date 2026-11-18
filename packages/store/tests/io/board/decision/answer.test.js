/** @pullboard-test-input source-cell store */
/** A decision answer may carry one ruling cause from the typed request cause list, and a cause outside it is refused [C7,#1444]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerDecision } from "../../../../index.js";
import { claim } from "../../../../index.js";
import { rulingsByCause } from "../../../../index.js";
import { shout } from "../../../../index.js";
import { TYPED_REQUEST_CAUSES } from "../../../../src/io/requests.js";
import { fixtureBoard } from "../../../../../board/tests/fixtures/board.js";
import { cellItem } from "../../../fixtures/cell.js";
import { cellSeat } from "../../../fixtures/cell.js";

const LANES = ["coordinator", "web"];

/** A board with a coordinator, a builder and one open decision from the builder, plus the event detail an answer wrote. */
function openDecision(t) {
  const board = fixtureBoard(t);
  cellSeat(board, { lane: "coordinator", path: "/answer-root" });
  const builder = cellSeat(board, { lane: "web", path: "/answer-root/web-1" }).id;
  const item = cellItem(board, { lane: "web", title: "Answer a decision with a cause", criterion: "The page renders.", specIds: ["G1"] }).item_id;
  claim(board, item, { agentId: builder, lane: "web", leaseMs: 7_200_000, freeze: () => ({ text: '{"rows":[]}', digest: "d".repeat(64) }) });
  const ask = shout(board, { from: builder, to: "coordinator", item, text: "Which interface should this expose?", decision: true, options: ["Local", "Shared"], lanes: LANES });
  return { board, ask };
}

/** The detail of the answer event for one ask, or null when the ask has no answer. */
function answerDetail(board, ask) {
  const row = board.db.prepare("SELECT event_detail FROM event WHERE event_kind = ? ORDER BY event_id DESC").all("answer").map((found) => JSON.parse(found.event_detail)).find((detail) => detail.answers === ask);
  return row ?? null;
}

test("store.io-board-decision-answer.cause-from-the-typed-list-is-recorded: clause 1: an answer given cause design-choice records that key on the answer event [C7,#1444]", (t) => {
  assert.ok(TYPED_REQUEST_CAUSES.includes("design-choice"));
  const { board, ask } = openDecision(t);
  answerDecision(board, ask, { agentId: "coordinator", text: "Shared", lanes: LANES, cause: "design-choice" });
  assert.equal(answerDetail(board, ask).cause, "design-choice");
});

test("store.io-board-decision-answer.cause-outside-the-list-is-refused: clause 2: a cause outside TYPED_REQUEST_CAUSES is refused RULING_CAUSE and writes no answer; no cause records as before [C7,#1444]", (t) => {
  const { board, ask } = openDecision(t);
  assert.throws(() => answerDecision(board, ask, { agentId: "coordinator", text: "Shared", lanes: LANES, cause: "because" }), { code: "RULING_CAUSE" });
  assert.equal(answerDetail(board, ask), null, "the refused answer wrote no answer event");
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM shout WHERE shout_answers = ?").get(ask).n, 0);
  answerDecision(board, ask, { agentId: "coordinator", text: "Local", lanes: LANES });
  assert.equal(Object.hasOwn(answerDetail(board, ask), "cause"), false, "an answer given no cause records no cause key");
});

/** Ask one more decision on the board of openDecision and answer it with the given text and cause; returns the answer's shout id. */
function ruled({ board }, text, cause) {
  const builder = board.db.prepare("SELECT agent_id FROM agent WHERE agent_lane = ?").get("web").agent_id;
  const item = board.db.prepare("SELECT item_id FROM item").get().item_id;
  const ask = shout(board, { from: builder, to: "coordinator", item, text: `Which way for ${text}?`, decision: true, options: ["Local", "Shared"], lanes: LANES });
  return answerDecision(board, ask, { agentId: "coordinator", text, lanes: LANES, ...(cause === undefined ? {} : { cause }) });
}

test("store.io-board-decision-answer.every-ruling-under-a-cause-newest-first: clause 1: rulingsByCause returns the answers recorded with cause design-choice, newest first, each with its shout id, text, answerer and time [C7,#1444]", (t) => {
  const seat = openDecision(t);
  const first = ruled(seat, "Shared one", "design-choice");
  ruled(seat, "Other cause", "tool-defect");
  ruled(seat, "No cause");
  const last = ruled(seat, "Shared two", "design-choice");
  const found = rulingsByCause(seat.board, "design-choice");
  assert.deepEqual(found.map((row) => row.shout), [last, first]);
  assert.deepEqual(found.map((row) => row.text), ["Shared two", "Shared one"]);
  assert.deepEqual(found.map((row) => row.answerer), ["coordinator", "coordinator"]);
  assert.ok(found.every((row) => typeof row.at === "string" && row.at.length > 0), "each ruling carries its time");
});

test("store.io-board-decision-answer.rulings-cause-outside-the-list-is-refused: clause 2: a cause outside TYPED_REQUEST_CAUSES is refused RULING_CAUSE and a valid cause with no answers returns an empty list [C7,#1444]", (t) => {
  const seat = openDecision(t);
  assert.throws(() => rulingsByCause(seat.board, "not-a-cause"), { code: "RULING_CAUSE" });
  assert.deepEqual(rulingsByCause(seat.board, "person-authority"), []);
});

test("store.io-board-decision-answer.rulings-lookup-is-exported-from-the-front-door: clause 3: rulingsByCause is exported from packages/store/index.js and is the function defined in answer.js [C7,#1444]", async () => {
  const defined = await import("../../../../src/io/board/decision/answer.js");
  assert.equal(typeof rulingsByCause, "function");
  assert.equal(rulingsByCause, defined.rulingsByCause);
});
