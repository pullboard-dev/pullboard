/** Observe family review cover without changing reservations or consulting another checkout's Git [C7,#3076]. */
import { hasSeatWake } from '../../../seats/index.js';
import {
  boardId,
  canonicalFamily,
  listAgents,
  listItems,
  itemThread,
  reviewHolder,
  seatFamily,
  withLocalSeatPresence,
} from '../../../store/index.js';
import { eligibilityProblem } from '../../../verify/index.js';

export const REVIEW_COVER_WAIT_MS = 5 * 60_000;
export const REVIEW_COVER_BACKLOG = 3;
import { REVIEW_COVER_PAUSE_TAIL } from '../../light.js';
export { REVIEW_COVER_PAUSE_TAIL };

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
  const rows = greenReviews(board, items, board.clock.now().getTime());
  const refusals = new Map();
  /** The item-author refusal for a seat, memoized: null when the seat may verify, else the refusal code. */
  const refusal = (row, seat) => {
    const key = `${row.item.item_id}:${seat.agent_id}`;
    if (!refusals.has(key)) refusals.set(key, eligibilityProblem(board, row.item, seat, { policy: config.verify?.policy, familyPolicy: 'require' })?.code ?? null);
    return refusals.get(key);
  };
  const independent = row => seats.filter(seat => families.get(seat.agent_id) && families.get(seat.agent_id) !== row.family
    && (seat.presence === 'live' || wakeable.has(seat.agent_id)));
  const itemConflict = new Set(['SELF_VERIFY', 'SELF_SESSION_VERIFY']);
  const waiting = rows.map(row => ({ ...row,
    covered: seats.some(seat => families.get(seat.agent_id) && families.get(seat.agent_id) !== row.family
      && !reviewing.has(seat.agent_id) && (seat.presence === 'live' || wakeable.has(seat.agent_id)) && refusal(row, seat) === null),
    // #3086: independent cover exists (a seat may verify another waiting review) but each such seat is refused for this item by its own history.
    conflicted: (() => {
      const pool = independent(row);
      return pool.length > 0 && pool.every(seat => itemConflict.has(refusal(row, seat)))
        && pool.some(seat => rows.some(other => other !== row && other.family === row.family && refusal(other, seat) === null));
    })(),
    neededFamilies: declared.filter(family => family !== row.family),
  }));
  return { missingFamilies, waiting };
}

/**
 * The stuck review backlog of one seat's family, or null: at least three renderable green reviews wait, one for five minutes
 * with no eligible live or wakeable reviewer from another family [#3792].
 */
export function reviewFamilyBacklog(info, board, config, seat) {
  if (config.verify?.family === 'off') return null;
  const family = canonicalFamily(board, seatFamily(board, seat.agent_id ?? seat.id));
  if (!family) return null;
  const { waiting } = reviewFamilyCover(info, board, config);
  const own = waiting.filter(row => row.family === family && !row.conflicted);
  if (own.length < REVIEW_COVER_BACKLOG || !own.some(row => !row.covered && row.ageMs >= REVIEW_COVER_WAIT_MS)) return null;
  return { family, own };
}

/** The explanation of a backlog; kept as the old pause wording so it reads the same wherever it is shown. */
export function reviewFamilyBuildPause(info, board, config, seat) {
  const backlog = reviewFamilyBacklog(info, board, config, seat);
  return backlog && `${backlog.family} has ${backlog.own.length} waiting green reviews and no eligible live or wakeable reviewer from another family; ${REVIEW_COVER_PAUSE_TAIL}`;
}

/**
 * Raise one Stuck shout to the coordinator and the person naming how many green items wait for review and the missing
 * reviewer family. Builds never wait on review cover: this shout is how the backlog reaches whoever wakes or adds reviewers.
 * It repeats only when the waiting count grows past the newest earlier shout for the same family, so one family's count never hides another's [#3792].
 */
export async function shoutReviewCoverStuck(ctx, board, ordered, seat) {
  const backlog = reviewFamilyBacklog(ctx.info, board, ctx.config, seat);
  if (!backlog) return false;
  const count = backlog.own.length;
  const missing = [...new Set(backlog.own.flatMap(row => row.neededFamilies))].join(', ') || 'another family';
  const last = board.db.prepare("SELECT shout_text FROM shout WHERE shout_from='sentinel' AND shout_to='coordinator' AND shout_text LIKE ? ORDER BY shout_id DESC LIMIT 1").get(`Stuck: review cover. ${backlog.family} has %`);
  const before = Number(/ has (\d+) green items/u.exec(last?.shout_text ?? '')?.[1] ?? 0);
  if (count <= before) return false;
  const text = `Stuck: review cover. ${backlog.family} has ${count} green items waiting for review and no live or wakeable ${missing} reviewer. Wake or add one; builds continue.`;
  try {
    for (const to of ['coordinator', 'person']) await ordered(ctx, board, 'shout', [{ from: 'sentinel', to, lanes: [], text }]);
  } catch (error) {
    // A refused shout must never stop the build line it only reports on.
    if (!/^[A-Z][A-Z_]+$/u.test(String(error?.code))) throw error;
    return false;
  }
  return true;
}

/** The fact that marks one conflicted submission as already shouted; a new head is a new episode. */
function markerText(item) {
  return JSON.stringify({ reviewCoverConflict: { commit: item.item_commit } });
}

/** Shout each conflicted waiting review once; the marker fact keeps an unchanged review quiet on every later sweep. */
export async function shoutConflictedReviews(ctx, board, ordered) {
  const { waiting } = reviewFamilyCover(ctx.info, board, ctx.config);
  const shouted = [];
  for (const row of waiting.filter(entry => entry.conflicted)) {
    const text = markerText(row.item);
    if (itemThread(board, row.item.item_id).some(entry => entry.type === 'fact' && entry.text === text)) continue;
    await ordered(ctx, board, 'appendFact', [row.item.item_id, { agentId: 'coordinator', kind: 'note', text }]);
    await ordered(ctx, board, 'shout', [{ from: 'sentinel', to: 'coordinator', lanes: [],
      text: `#${row.item.item_id} is green but every independent reviewer is refused by its own history of the item; it no longer counts toward the build pause. Give it a reviewer from another family.` }]);
    shouted.push(row.item.item_id);
  }
  return shouted;
}
