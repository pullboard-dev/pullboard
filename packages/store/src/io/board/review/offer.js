import { REVIEWS_FIRST_ENGINE } from '../../../../../state/light.js';
import { ENGINE_VERSION } from '../../../../../state/index.js';
import { lineSettings } from '../../../../../state/index.js';
import { reviewOffer as capacityReviewOffer } from "../../../../../seats/index.js";
import { nextFor } from "../next.js";
import { pendingSubmitHandoff } from "../../submit/handoff/records.js";
import { greenReviewFor } from "../next.js";
import {
  listItems,
  reviewHolder,
  reviewQueue,
} from "../query.js";
import { overdueReview } from "../../../../../verify/index.js";

/** Return the oldest eligible review waiting two minutes so an unclaimed seat does not build past it [C7,#3077]. */
function firstAgedReview(board, who) {
  const skip = new Set(who.skipIds ?? []);
  const order = new Map();
  const submitted = board.db.prepare("SELECT event_id,event_at FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1");
  for (const item of listItems(board)) {
    if (item.item_status !== 'submitted') continue;
    const event = submitted.get(item.item_id);
    if (!event || board.clock.now().getTime() - Date.parse(event.event_at) < 2 * 60_000) skip.add(item.item_id);
    else order.set(item.item_id, { at: Date.parse(event.event_at), sequence: event.event_id });
  }
  if (!order.size) return null;
  return nextFor(board, { ...who, verify: true, priority: [], skipIds: [...skip], reviewOrder: order });
}

/** Offer an eligible review at the queue ratio without claiming or reserving anything [Q1,V15]. */
export function reviewOffer(board, who) {
  const holding = listItems(board).some(item => item.item_status === 'claimed'
    && item.item_owner === who.agentId && !pendingSubmitHandoff(board, item));
  if (!holding) {
    const aged = firstAgedReview(board, who);
    if (aged?.item) return { item: aged.item, queue: reviewQueue(board), mandatory: true, urgent: 'age', starveMinutes: 2 };
  }
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEWS_FIRST_ENGINE && lineSettings(board).reviewsFirst === true) {
    if (listItems(board).some(item => item.item_status === 'submitted' && reviewHolder(board, item) === who.agentId)) {
      return who.mandatoryOnly ? null : capacityReviewOffer(board, who, nextFor, { reviewQueue, reviewHolder, listItems, overdueReview });
    }
    const skip = new Set(who.skipIds ?? []);
    const reviewOrder = new Map();
    for (const item of listItems(board)) {
      if (item.item_status !== 'submitted') continue;
      const submit = board.db.prepare("SELECT event_id,event_at FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1").get(item.item_id);
      const reserved = submit && board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='reserve' AND event_id>? LIMIT 1").get(item.item_id, submit.event_id);
      if (!submit || reserved || !(board.clock.now().getTime() - Date.parse(submit.event_at) > 15 * 60_000)) skip.add(item.item_id);
      else reviewOrder.set(item.item_id, { at: Date.parse(submit.event_at), sequence: submit.event_id });
    }
    const picked = nextFor(board, { ...who, verify: true, priority: [], skipIds: [...skip], reviewOrder });
    if (picked.item) return { item: picked.item, queue: reviewQueue(board), mandatory: true, urgent: 'first-review', starveMinutes: 15 };
  }
  // A green, unreserved submission comes before any build with no starvation wait, for the mandatory-only offer and
  // the full one alike: plain next reads the mandatory review from the full offer (#2978, #2992).
  const green = greenReviewFor(board, who);
  if (green) return { item: green, queue: reviewQueue(board), mandatory: true, urgent: 'green-review' };
  if (who.mandatoryOnly) return null;
  return capacityReviewOffer(board, who, nextFor, { reviewQueue, reviewHolder, listItems, overdueReview });
}
