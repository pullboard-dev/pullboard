/** The clearReviewReservation descriptor routes at CLEAR_REVIEW_RESERVATION_ENGINE and names a next step for each refusal [C7]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLEAR_REVIEW_RESERVATION_ENGINE } from "../../../../state/light.js";
import clearReviewReservation from "../../../src/logic/moves/clearReviewReservation.js";

test('moves.clear-review-reservation.descriptor: clause 1: clearReviewReservation names its operation, reads its actor from args[1].agentId and routes at CLEAR_REVIEW_RESERVATION_ENGINE [C7]', () => {
  assert.equal(clearReviewReservation.operation, "clearReviewReservation");
  assert.equal(clearReviewReservation.actor({ args: [7, { agentId: "coordinator" }] }), "coordinator");
  assert.equal(clearReviewReservation.actor({ args: [] }), null);
  assert.equal(clearReviewReservation.minimumEngine(), CLEAR_REVIEW_RESERVATION_ENGINE);
});

test('moves.clear-review-reservation.next-steps: clause 2: ENGINE_VERSION, NOT_SUBMITTED and USAGE each map to a next step [C7]', () => {
  for (const code of ["ENGINE_VERSION", "NOT_SUBMITTED", "USAGE"]) assert.match(clearReviewReservation.nextSteps[code], /pullboard/u, code);
});
