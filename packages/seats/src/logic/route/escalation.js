/** Model route policy and rejection receipts for automatic escalation [B13,B15,H16]. */
import { COORDINATOR } from '../../../../queue/light.js';
import { AUTO_ESCALATE_ENGINE } from '../../../../state/light.js';
import { STRONG_REJECTION_NOTICE_ENGINE } from '../../../../state/light.js';
import { verdictRows } from '../rows.js';

/**
 * Who can take an item (B13), as tiers in order of the model an item needs: `light` is work a small
 * or local model can build from its brief, `mid` needs a capable general model, and
 * `strong` needs a frontier model's judgment. An agent's route is set when it joins; it takes items
 * at its tier and below.
 */
export const ROUTES = ['light', 'mid', 'strong'];

/**
 * True when an agent on `agentRoute` may build or verify an item routed `itemRoute`.
 *
 * @param {string} agentRoute
 * @param {string} itemRoute
 * @returns {boolean}
 */
export const canTake = (agentRoute, itemRoute) => ROUTES.indexOf(itemRoute) <= ROUTES.indexOf(agentRoute);

/**
 * The lower of a seat's joined route and a session's cap, so the model running in a seat narrows what it takes [#3678].
 * Why narrowing only: a claim the cap allows is one the stored route allows too, so replaying the event log agrees.
 *
 * @param {string} route
 * @param {string | null | undefined} cap
 * @returns {string}
 */
export const cappedRoute = (route, cap) => ROUTES.includes(cap) && ROUTES.indexOf(cap) < ROUTES.indexOf(route) ? cap : route;

/** Return rejected verdict receipts since the item's most recent route change [B15,B13].
 *
 * @param {any} board
 * @param {number} id
 * @returns {object[]}
 */
function rejectionsSinceRouteChange(board, id, engine) {
  const thread = board.db.prepare('SELECT * FROM event WHERE item_id = ? ORDER BY event_id').all(id);
  let lastRouteChange = -1;
  for (const [index, event] of thread.entries()) {
    if (event.event_kind === 'escalate') {
      lastRouteChange = index;
      continue;
    }
    if (engine >= STRONG_REJECTION_NOTICE_ENGINE && event.event_kind === 'strong-rejection-notice'
      && JSON.parse(event.event_detail).engine === STRONG_REJECTION_NOTICE_ENGINE) lastRouteChange = index;
    if (event.event_kind === 'edit' && Object.hasOwn(JSON.parse(event.event_detail), 'route')) lastRouteChange = index;
  }
  const verdictEvents = thread.filter((event) => ['accept', 'reject'].includes(event.event_kind));
  const verdicts = verdictRows(board, id);
  const byEvent = new Map(verdictEvents.map((event, index) => [event.event_id, verdicts[index]]));
  return thread.slice(lastRouteChange + 1).flatMap((event) => {
    if (event.event_kind !== 'reject') return [];
    const verdict = byEvent.get(event.event_id);
    if (!verdict || verdict.verdict_decision !== 'REJECT') return [];
    return [{
      eventId: event.event_id,
      verdictId: verdict.verdict_id,
      by: verdict.verdict_by,
      reason: verdict.verdict_reason,
      note: verdict.verdict_note,
      commit: verdict.verdict_commit,
      digest: verdict.verdict_digest,
      head: verdict.verdict_head,
      at: verdict.verdict_at,
    }];
  });
}

/** Describe the existing escalation move after two rejects at this route [B15,H16].
 *
 * The caller applies the move inside the verdict's transaction, so a refusal still rolls back
 * both the verdict and escalation. Older engines never consult the new rejection history.
 *
 * @param {any} board
 * @param {number} id
 * @param {number} engine
 * @param {string} route
 * @returns {{ agentId: string, note: string, rejections: object[] } | null}
 */
export function rejectedItemEscalation(board, id, engine, route) {
  if (engine < AUTO_ESCALATE_ENGINE) return null;
  const rejections = rejectionsSinceRouteChange(board, id, engine).slice(-2);
  if (rejections.length < 2) return null;
  return {
    agentId: COORDINATOR,
    note: `Two REJECT verdicts at the ${route} route`,
    rejections,
  };
}

/** Finish the rejection's route action atomically; old engines retain ceiling escalation [B15,H16]. */
export function recordRejectedItemRoute(board, id, engine, item, { escalate, shout, logEvent, routeCalibrationEngine }) {
  if (routeCalibrationEngine && engine >= routeCalibrationEngine) {
    const latest = verdictRows(board, id).at(-1);
    const seatRoute = latest && board.db.prepare('SELECT agent_route FROM agent WHERE agent_id=?').get(latest.verdict_by)?.agent_route;
    if (latest?.verdict_decision === 'REJECT' && latest.verdict_reason === 'TEST_FAILURE' && seatRoute === item.item_route) {
      escalate(board, id, { agentId: COORDINATOR, note: `${latest.verdict_by} rejected at the ${seatRoute} route: ${latest.verdict_reason} (${latest.verdict_note})` });
      return;
    }
  }
  const escalation = rejectedItemEscalation(board, id, engine, item.item_route);
  if (!escalation) return;
  if (engine < STRONG_REJECTION_NOTICE_ENGINE || item.item_route !== ROUTES.at(-1)) {
    escalate(board, id, escalation);
    return;
  }
  const builder = item.item_built_by ?? item.item_owner;
  logEvent(board, COORDINATOR, 'strong-rejection-notice', id, {
    engine: STRONG_REJECTION_NOTICE_ENGINE, route: item.item_route, builder, rejections: escalation.rejections,
  });
  const receipts = escalation.rejections.map(entry => `#${entry.verdictId} (${entry.reason})`).join(', ');
  shout(board, { from: 'sentinel', to: COORDINATOR, lanes: [COORDINATOR],
    text: `#${id} has two send-backs at the strongest route; ${builder} built it. Rejections: ${receipts}.` });
}
