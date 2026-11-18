/** A rulings lookup returns every ruling recorded under one cause key, newest first, and refuses a cause outside the typed list [C7,#1444]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerDecision } from "../../../../index.js";
import { claim } from "../../../../index.js";
import { rulingsByCause } from "../../../../index.js";
import { shout } from "../../../../index.js";
import { fixtureBoard } from "../../../../../board/tests/fixtures/board.js";
import { cellItem } from "../../../fixtures/cell.js";
import { cellSeat } from "../../../fixtures/cell.js";

const LANES = ["coordinator", "web"];

/** A board with a coordinator, a builder and a claimed item, from which decisions can be asked and answered. */
function board(t) {
  const found = fixtureBoard(t);
  cellSeat(found, { lane: "coordinator", path: "/rulings-root" });
  const builder = cellSeat(found, { lane: "web", path: "/rulings-root/web-1" }).id;
  const item = cellItem(found, { lane: "web", title: "Look up rulings by cause", criterion: "The page renders.", specIds: ["G1"] }).item_id;
  claim(found, item, { agentId: builder, lane: "web", leaseMs: 7_200_000, freeze: () => ({ text: '{"rows":[]}', digest: "d".repeat(64) }) });
  return { found, builder, item };
}

/** Ask one decision and answer it with the given text and cause; returns the answer's shout id. */
function ruled({ found, builder, item }, text, cause) {
  const ask = shout(found, { from: builder, to: "coordinator", item, text: `Which way for ${text}?`, decision: true, options: ["Local", "Shared"], lanes: LANES });
  return answerDecision(found, ask, { agentId: "coordinator", text, lanes: LANES, ...(cause === undefined ? {} : { cause }) });
}

test("store.io-board-decision-rulings.every-ruling-under-a-cause-newest-first: clause 1: rulingsByCause returns the answers recorded with cause design-choice, newest first, each with its shout id, text, answerer and time [C7,#1444]", (t) => {
  const seat = board(t);
  const first = ruled(seat, "Shared one", "design-choice");
  ruled(seat, "Other cause", "tool-defect");
  ruled(seat, "No cause");
  const last = ruled(seat, "Shared two", "design-choice");
  const found = rulingsByCause(seat.found, "design-choice");
  assert.deepEqual(found.map((row) => row.shout), [last, first]);
  assert.deepEqual(found.map((row) => row.text), ["Shared two", "Shared one"]);
  assert.deepEqual(found.map((row) => row.answerer), ["coordinator", "coordinator"]);
  assert.ok(found.every((row) => typeof row.at === "string" && row.at.length > 0), "each ruling carries its time");
});

test("store.io-board-decision-rulings.cause-outside-the-list-is-refused: clause 2: a cause outside TYPED_REQUEST_CAUSES is refused RULING_CAUSE and a valid cause with no answers returns an empty list [C7,#1444]", (t) => {
  const seat = board(t);
  assert.throws(() => rulingsByCause(seat.found, "not-a-cause"), { code: "RULING_CAUSE" });
  assert.deepEqual(rulingsByCause(seat.found, "person-authority"), []);
});
