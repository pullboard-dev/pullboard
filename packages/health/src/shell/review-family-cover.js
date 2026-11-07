/** Observe family review cover without changing reservations or consulting another checkout's Git [C7,#3076]. */
import { hasSeatWake } from '../../../seats/index.js';
import {
  boardId,
  canonicalFamily,
  listAgents,
  listItems,
  reviewHolder,
  seatFamily,
  withLocalSeatPresence,
} from '../../../store/index.js';
import { eligibilityProblem } from '../../../verify/index.js';

export const REVIEW_COVER_WAIT_MS = 5 * 60_000;
export const REVIEW_COVER_BACKLOG = 3;

/** Read source-bound green submissions once, including younger work in the family's backlog count. */
function greenReviews(board, items, at) {
  const submitted = board.db.prepare("SELECT event_at,event_detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1");
  return items.filter(item => item.item_status === 'submitted' && !reviewHolder(board, item)).flatMap(item => {
    const event = submitted.get(item.item_id);
    let detail;
    try { detail = JSON.parse(event?.event_detail ?? 'null'); } catch { return []; }
    const since = Date.parse(event?.event_at);
    if (detail?.gateGreen !== true || detail.commit !== item.item_commit || !Number.isFinite(since) || since > at) return [];
    return [{ item, since, ageMs: at - since, family: canonicalFamily(board, item.item_builder_family) }];
  });
}

/**
 * Observe declared vendor cover using the native board eligibility guards and local wake capabilities.
 * This is routing advice only: ordered claim/reservation guards never read these private observations.
 */
export function reviewFamilyCover(info, board, config) {
  if (config.verify?.family === 'off') return { missingFamilies: [], waiting: [] };
  const items = listItems(board);
  const seats = withLocalSeatPresence(board, listAgents(board)).filter(seat => seat.agent_id !== 'coordinator');
  const identity = boardId(board);
  const families = new Map(seats.map(seat => [seat.agent_id, canonicalFamily(board, seat.agent_family)]));
  const wakeable = new Set(seats.filter(seat => hasSeatWake(info, { boardId: identity, seat })).map(seat => seat.agent_id));
  const declared = [...new Set([...families.values()].filter(Boolean))].sort();
  const missingFamilies = declared.filter(family => !seats.some(seat => families.get(seat.agent_id)
    && families.get(seat.agent_id) !== family && wakeable.has(seat.agent_id)));
  const reviewing = new Set(items.filter(item => reviewHolder(board, item)).map(item => item.item_review_by));
  const waiting = greenReviews(board, items, board.clock.now().getTime()).map(row => ({ ...row,
    covered: seats.some(seat => families.get(seat.agent_id) && families.get(seat.agent_id) !== row.family
      && !reviewing.has(seat.agent_id) && (seat.presence === 'live' || wakeable.has(seat.agent_id))
      && !eligibilityProblem(board, row.item, seat, { policy: config.verify?.policy, familyPolicy: 'require' })),
    neededFamilies: declared.filter(family => family !== row.family),
  }));
  return { missingFamilies, waiting };
}

/** Pause only new builds; existing claims and all independent review paths remain available. */
export function reviewFamilyBuildPause(info, board, config, seat) {
  if (config.verify?.family === 'off') return null;
  const family = canonicalFamily(board, seatFamily(board, seat.agent_id ?? seat.id));
  if (!family) return null;
  const { waiting } = reviewFamilyCover(info, board, config);
  const own = waiting.filter(row => row.family === family);
  if (own.length < REVIEW_COVER_BACKLOG || !own.some(row => !row.covered && row.ageMs >= REVIEW_COVER_WAIT_MS)) return null;
  return `${family} has ${own.length} waiting green reviews and no eligible live or wakeable reviewer from another family; new builds wait for independent review cover`;
}
