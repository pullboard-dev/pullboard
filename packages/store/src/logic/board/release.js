/** Releases the machine caused, which the release-twice hold must not count [C7,H16]. */
import { INFRA_RELEASE_ENGINE } from '../../../../state/light.js';
import { REVIEW_RELEASE_TWICE_ENGINE } from '../../../../state/light.js';
import { ENGINE_VERSION } from '../../../../state/index.js';

/**
 * True when a release was caused by infrastructure: it names INFRA, or the holder's last submit handoff
 * since their claim ended in infrastructure.
 * Why: runner and board outages made seats file BLOCKED, and two of those locked the item for everyone.
 *
 * @param {object} board the open board
 * @param {number} id the item
 * @param {{event_id:number,event_by:string}} row the release event
 * @param {{reasonCode?:string}} detail the release event's detail
 * @returns {boolean} whether the release is infrastructure-caused
 */
export function infraRelease(board, id, row, detail) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < INFRA_RELEASE_ENGINE) return false;
  if (detail.reasonCode === 'INFRA') return true;
  const claim = board.db.prepare(`SELECT event_id FROM event WHERE item_id=? AND event_kind='claim' AND event_id<? ORDER BY event_id DESC LIMIT 1`).get(id, row.event_id);
  const last = board.db.prepare(`SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit-handoff' AND event_by=? AND event_id>? AND event_id<? ORDER BY event_id DESC LIMIT 1`)
    .get(id, row.event_by, claim?.event_id ?? 0, row.event_id);
  if (!last) return false;
  try { return JSON.parse(last.event_detail).state === 'infrastructure'; } catch { return false; }
}

/** The last two holder-chosen releases of an item since its last unhold, newest first, infrastructure ones included. */
export function lastChosenReleases(board, id, chosen) {
  return board.db.prepare(`SELECT event_id, event_by, event_detail FROM event WHERE item_id = ? AND event_kind = 'release'
    AND event_id > COALESCE((SELECT MAX(event_id) FROM event WHERE item_id = ? AND event_kind = 'unhold_item'), 0)
    ORDER BY event_id DESC`).all(id, id).filter(row => chosen(row, JSON.parse(row.event_detail))).slice(0, 2);
}

/**
 * Lift a "Released twice" hold on the next board write for its item when both counted releases were infrastructure-caused.
 *
 * @param {object} board the open board
 * @param {object} event the event just written
 * @param {Function} logEvent writes an event
 * @param {Function} setItem patches an item
 */
export function liftInfraHold(board, event, logEvent, setItem) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < INFRA_RELEASE_ENGINE || event.item_id === null
    || ['hold_item', 'unhold_item', 'release'].includes(event.event_kind)) return;
  const item = board.db.prepare('SELECT item_hold_reason,item_hold_by FROM item WHERE item_id=?').get(event.item_id);
  if (!item?.item_hold_reason?.startsWith('Released twice') || item.item_hold_by !== 'coordinator') return;
  const releases = lastChosenReleases(board, event.item_id, (row, detail) => ['BLOCKED', 'BUDGET', 'INELIGIBLE', 'INFRA'].includes(detail.reasonCode)
    && !detail.review && !detail.staleClaim && !detail.goneSeat && !detail.idleClaim && !detail.expiredClaim && !detail.untouchedAutoClaim && !detail.exitHandoff);
  if (releases.length !== 2 || !releases.every(row => infraRelease(board, event.item_id, row, JSON.parse(row.event_detail)))) return;
  setItem(board, event.item_id, { item_hold_reason: null, item_hold_by: null, item_hold_at: null }, event.event_at);
  logEvent(board, 'coordinator', 'unhold_item', event.item_id, { reason: item.item_hold_reason, cause: 'infrastructure' });
}

/** Item ids a release names as its blocker; the event records one id, a list, or a "#id" string. */
function namedBlockers(detail) {
  const named = Array.isArray(detail.blockedOn) ? detail.blockedOn : detail.blockedOn === undefined ? [] : [detail.blockedOn];
  return named.map(value => Number(String(value).replace(/^#/u, ''))).filter(Number.isSafeInteger);
}

/**
 * With release.liftTwiceHold on, lift an automatic "Released twice" hold when main moves, or when an item one of its two releases
 * named as a blocker lands. A person's or the coordinator's own hold is untouched: only the hold the release-twice rule placed lifts.
 * Why: the hold waits for a change that may already have happened, and nobody was told to look again (#9002).
 *
 * @param {object} board the open board; `board.liftTwiceHold` is the setting, off unless it is true
 * @param {object} event the event just written
 * @param {Function} logEvent writes an event
 * @param {Function} setItem patches an item
 */
export function liftTwiceHold(board, event, logEvent, setItem) {
  if (board.liftTwiceHold !== true || !['main-moved', 'merged'].includes(event.event_kind)) return;
  const held = board.db.prepare(`SELECT item_id,item_hold_reason FROM item WHERE item_hold_by='coordinator' AND item_hold_reason LIKE 'Released twice%'`).all();
  for (const item of held) {
    if (item.item_id === event.item_id) continue;
    const hold = board.db.prepare(`SELECT event_id,event_detail FROM event WHERE item_id=? AND event_kind='hold_item' ORDER BY event_id DESC LIMIT 1`).get(item.item_id);
    if (!hold || hold.event_id >= event.event_id || JSON.parse(hold.event_detail).automatic !== 'release-twice') continue;
    const mainMoved = event.event_kind === 'main-moved';
    const blocked = !mainMoved && lastChosenReleases(board, item.item_id, () => true).some(row => namedBlockers(JSON.parse(row.event_detail)).includes(event.item_id));
    if (!mainMoved && !blocked) continue;
    setItem(board, item.item_id, { item_hold_reason: null, item_hold_by: null, item_hold_at: null }, event.event_at);
    logEvent(board, 'coordinator', 'unhold_item', item.item_id, { reason: item.item_hold_reason, cause: mainMoved ? 'main-moved' : 'blocker-landed', triggerEventId: event.event_id });
  }
}

/**
 * The review releases of an item since its latest submit, oldest first, each { by, family, reason }; the family is the seat's recorded model family.
 * Why: the release table holds an item whose review one family releases twice without a verdict; releases the sentinel made for an idle or gone reviewer are not the family's choice [C7].
 *
 * @param {object} board the open board
 * @param {number} id the item
 * @returns {{by:string,family:string|null,reason:string}[]} the counted review releases
 */
export function reviewReleases(board, id) {
  const since = board.db.prepare(`SELECT MAX(event_id) AS last FROM event WHERE item_id = ? AND event_kind = 'submit'`).get(id)?.last ?? 0;
  return board.db.prepare(`SELECT event_by, event_detail FROM event WHERE item_id = ? AND event_kind = 'release' AND event_id > ? ORDER BY event_id`).all(id, since)
    .map(row => ({ by: row.event_by, detail: JSON.parse(row.event_detail || '{}') }))
    .filter(({ detail }) => detail.review === true && !detail.staleClaim && !detail.idleClaim && !detail.expiredClaim && !detail.goneSeat)
    .map(({ by, detail }) => ({ by, family: board.db.prepare('SELECT agent_family AS family FROM agent WHERE agent_id = ?').get(by)?.family ?? null, reason: detail.reason ?? detail.reasonCode ?? '' }));
}

/**
 * What the release table needs to hold an item after a second review release by one family: the board's replay engine and the counted releases, or null when the rule is off.
 * Why: the rule runs only with board.holdAfterTwoReleases on, at or above REVIEW_RELEASE_TWICE_ENGINE, on a submitted item, so older boards keep their decisions [C7].
 *
 * @param {object} board the open board
 * @param {object} item the item row before the release
 * @returns {{engine:number,reviewReleases:object[]}|null} the snapshot additions, or null
 */
export function reviewHoldState(board, item) {
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (board.holdAfterTwoReleases !== true || engine < REVIEW_RELEASE_TWICE_ENGINE || item.item_status !== 'submitted') return null;
  return { engine, reviewReleases: reviewReleases(board, item.item_id) };
}
