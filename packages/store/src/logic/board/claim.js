import { itemDiagnosis } from '../item/diagnosis.js';
import { RELEASE_QUALITY_HOLD_ENGINE } from '../../../../state/light.js';
import { UNTOUCHED_CLAIM_ENGINE } from '../../../../state/light.js';
import { BLOCKED_DEPENDENCIES_ENGINE } from '../../../../state/light.js';
import { validateNativeDependencies } from '../../../../seats/browser.js';
import { localDependencyIds } from '../../../../seats/browser.js';
import { releaseReasonProblem } from "../reasons.js";
import { releaseExitClaim } from "../exit/rules/claim.js";
import { infraRelease } from './release.js';
import { lastChosenReleases } from './release.js';
import { staleClaimRelease } from "./stale/claim.js";
/** Ordinary claim/review releases, including recorded coordinator gone-seat observations. */
import { Refused } from "../../../../kernel/light.js";
import {
  ENGINE_VERSION,
  MOVES,
  IN_STATE,
  REOPEN_FIRST_REFUSAL_ENGINE,
} from "../../../../state/index.js";
import { firstRefusal } from "./item/lookup.js";
import { GONE_CLAIM_ENGINE } from "../../../../state/light.js";
import { RELEASE_TWICE_HOLD_ENGINE } from "../../../../state/light.js";
import { RELEASE_REASONS_ENGINE } from "../../../../state/index.js";
import { ROUTE_CALIBRATION_ENGINE } from "../../../../state/light.js";
import { RELEASE_TWICE_ROUTE_ENGINE } from "../../../../state/light.js";

/**
 * The id of the item's latest escalation that actually changed its route (0 when none).
 * Why: a second quality release escalates a light or mid item, and the releases before that move must not
 * count toward its next episode; a strong item's no-op escalation changes nothing and so never resets the count.
 *
 * @param {object} board the open board
 * @param {number} id the item
 * @returns {number} the event id of the latest route-changing escalate event
 */
function lastRouteChange(board, id) {
  const rows = board.db.prepare("SELECT event_id, event_detail FROM event WHERE item_id=? AND event_kind='escalate' ORDER BY event_id DESC").all(id);
  for (const row of rows) {
    const detail = JSON.parse(row.event_detail ?? '{}');
    if (detail.from !== detail.to) return row.event_id;
  }
  return 0;
}

/** Validate frozen maintenance evidence without reading a replica's private presence cache. */
function goneRelease(board, item, actor, observation) {
  if (observation === undefined) return null;
  const at = observation?.lastSeen;
  const seen = typeof at === 'string' ? Date.parse(at) : NaN;
  const now = board.clock.now().getTime();
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < GONE_CLAIM_ENGINE) {
    throw new Refused('ENGINE_VERSION', 'gone-seat releases require the gone-claim engine; upgrade every linked writer');
  }
  if (actor !== 'coordinator' || item.item_status !== 'claimed' || item.item_owner !== observation?.seat
    || !(item.item_lease_until > board.clock.now().toISOString()) || !Number.isFinite(seen)
    || new Date(seen).toISOString() !== at || now - seen < 1_800_000
    || Object.keys(observation).some(key => !['seat', 'lastSeen'].includes(key))) {
    throw new Refused('NOT_YOURS', 'gone-seat maintenance requires the coordinator, a live claim, and its holder last seen at least 30 minutes ago');
  }
  return { seat: observation.seat, lastSeen: at };
}

/** Only a holder's structured quality release counts; OTHER has no reliable provenance. */
function chosenQualityRelease(board, id, row, detail) {
  if (!['BLOCKED', 'BUDGET', 'INELIGIBLE'].includes(detail.reasonCode)
    || detail.review || detail.staleClaim || detail.goneSeat || detail.idleClaim || detail.expiredClaim
    || detail.untouchedAutoClaim || detail.exitHandoff || infraRelease(board, id, row, detail)) return false;
  const previous = board.db.prepare(`SELECT event_kind, event_by FROM event WHERE item_id=? AND event_id<?
    AND event_kind IN ('claim','release','submit','withdraw','merged','reopen') ORDER BY event_id DESC LIMIT 1`).get(id, row.event_id);
  return previous?.event_kind === 'claim' && previous.event_by === row.event_by;
}

/** Apply the existing ordinary release transition with narrowly frozen maintenance authority. */
export function releaseClaim(board, id, agentId, note, observation, dependencies, reasonCode) {
  const { atomic, itemById, reviewHolder, reviewReleaseNoteProblem, setItem, moveItem, logEvent, insertShout, validateItemDependencies, escalate } = dependencies;
  // A string fourth argument is the release reason code; an object is a coordinator's frozen observation.
  if (typeof observation === 'string') { reasonCode = observation; observation = undefined; }
  const worktreeSnapshot = observation?.worktreeSnapshot;
  if (observation && Object.hasOwn(observation, 'worktreeSnapshot')) {
    const { worktreeSnapshot: ignored, ...other } = observation;
    observation = Object.keys(other).length ? other : undefined;
  }
  const blockedOn = observation?.blockedOn;
  let combinedAfter;
  if (blockedOn !== undefined) {
    if ((board.executionEngineVersion ?? ENGINE_VERSION) < BLOCKED_DEPENDENCIES_ENGINE) throw new Refused('ENGINE_VERSION', 'blocked dependencies require the current engine');
    if (reasonCode !== 'BLOCKED' || Object.keys(observation).length !== 1 || !Array.isArray(blockedOn) || !blockedOn.length) throw new Refused('BAD_DEPENDENCIES', '--on needs local item ids and --reason BLOCKED');
    validateNativeDependencies(blockedOn);
    if (localDependencyIds(blockedOn).length !== blockedOn.length) throw new Refused('BAD_DEPENDENCIES', '--on needs local item ids');
    observation = undefined;
  }
  return atomic(board, () => {
    if (reasonCode !== undefined || (board.executionEngineVersion ?? ENGINE_VERSION) >= RELEASE_REASONS_ENGINE) {
      const bad = releaseReasonProblem(reasonCode, note, board.executionEngineVersion ?? ENGINE_VERSION);
      if (bad) throw bad;
    }
    const item = itemById(board, id);
    if (blockedOn) {
      if (item.item_status !== 'claimed' || item.item_owner !== agentId) throw new Refused('NOT_YOURS', `item #${id} is not claimed by you`);
      combinedAfter = [...new Set([...String(item.item_after ?? '').split(',').filter(Boolean), ...blockedOn.map(String)])];
      validateItemDependencies(board, id, combinedAfter.map(value => /^\d+$/u.test(value) ? Number(value) : value));
    }
    const wrongDiagnosis = reasonCode === 'DIAGNOSIS_WRONG' ? itemDiagnosis(board, item) : null;
    if (reasonCode === 'DIAGNOSIS_WRONG' && (!wrongDiagnosis || item.item_status !== 'claimed' || item.item_owner !== agentId)) throw new Refused('DIAGNOSIS_WRONG', 'claim a diagnosed item before returning it for a new diagnosis');
    const stale = staleClaimRelease(board, item, agentId, note, observation);
    const gone = stale ? null : goneRelease(board, item, agentId, observation);
    if (item.item_status === 'submitted') {
      if (reviewHolder(board, item) !== agentId) {
        throw new Refused('NOT_YOURS', `item #${id} review is not reserved by you; ask its current reviewer to release it, or take a free review with pullboard next --verify`);
      }
      const currentEngine = board.executionEngineVersion ?? ENGINE_VERSION;
      const problem = currentEngine >= 5 ? reviewReleaseNoteProblem(board, id, agentId, note) : null;
      if (problem) throw problem;
      const reason = typeof note === 'string' ? note.trim() : '';
      setItem(board, id, { item_review_by: null, item_review_until: null });
      if (currentEngine >= 5) logEvent(board, agentId, 'release', id, { review: true, reason, ...(reasonCode === undefined ? {} : { reasonCode }) });
      else logEvent(board, agentId, 'release', id);
      return true;
    }
    const window = (board.executionEngineVersion ?? ENGINE_VERSION) >= REOPEN_FIRST_REFUSAL_ENGINE ? firstRefusal(board, id) : null;
    const exitHandoff = releaseExitClaim(board, id, agentId, note);
    moveItem(board, id, 'release', {
      transition: (board.executionEngineVersion ?? ENGINE_VERSION) < REOPEN_FIRST_REFUSAL_ENGINE ? { ...MOVES.find(move => move.verb === 'release'), from: ['claimed'] } : null,
      checks: {
        joined: null,
        [IN_STATE]: () => new Refused('NOT_YOURS', `item #${id} is not claimed by you`),
        releaseOwnsWork: (found) => (stale || gone || found.item_owner === agentId || found.item_status === 'open' && window?.builder === agentId ? null : new Refused('NOT_YOURS', `item #${id} is not claimed by you`)),
        reviewReleaseExplained: null, // Claimed releases do not free a submitted review.
      },
      set: () => ({ item_owner: null, item_lease_until: null, ...(blockedOn ? { item_after: combinedAfter.join(',') } : {}) }),
    });
    if (wrongDiagnosis) {
      board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run(`item_diagnosis:${id}`);
      setItem(board, id, { item_route: 'mid', item_brief: `Diagnosis rejected: ${note.trim()}\n\nPrevious diagnosis (context):\n${item.item_brief}` });
    }
    if (blockedOn) {
      const upsert = board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value');
      upsert.run(`claim_waiting:${id}`, JSON.stringify(blockedOn));
      upsert.run(`blocked_release_waiting:${id}`, JSON.stringify(blockedOn));
    }
    const lastClaim = board.db.prepare("SELECT event_by, event_detail FROM event WHERE item_id = ? AND event_kind = 'claim' ORDER BY event_id DESC LIMIT 1").get(id);
    const claimDetail = JSON.parse(lastClaim?.event_detail ?? '{}');
    const untouchedAutoClaim = (board.executionEngineVersion ?? ENGINE_VERSION) >= UNTOUCHED_CLAIM_ENGINE && !stale && !gone && !exitHandoff
      && lastClaim?.event_by === agentId && worktreeSnapshot?.head === claimDetail.autoNextSnapshot?.head && typeof worktreeSnapshot?.digest === 'string'
      && worktreeSnapshot.digest === claimDetail.autoNextSnapshot?.digest;
    logEvent(board, agentId, 'release', id, blockedOn ? { reasonCode, blockedOn, ...(untouchedAutoClaim ? { untouchedAutoClaim: true } : {}), ...(typeof note === 'string' && note.trim() ? { reason: note.trim() } : {}), ...(exitHandoff ? { exitHandoff } : {}) } : exitHandoff ? { exitHandoff, reason: note, ...(reasonCode === undefined ? {} : { reasonCode }) } : stale ? { staleClaim: stale, reason: stale.reason, ...(stale.expiredClaim ? { expiredClaim: stale.expiredClaim, reopenFirstRefusal: stale.reopenFirstRefusal } : {}), ...(reasonCode === undefined ? {} : { reasonCode }) } : gone ? { goneSeat: gone, reason: `Released gone seat ${gone.seat}; last seen ${gone.lastSeen}.`, ...(reasonCode === undefined ? {} : { reasonCode }) } : reasonCode === undefined ? undefined : { reasonCode, ...(untouchedAutoClaim ? { untouchedAutoClaim: true } : {}), ...(typeof note === 'string' && note.trim() ? { reason: note.trim() } : {}) });
    // Preserve historic replay while new moves count only the holder's chosen quality releases.
    const qualityHolds = (board.executionEngineVersion ?? ENGINE_VERSION) >= RELEASE_QUALITY_HOLD_ENGINE;
    const currentEligible = qualityHolds ? !stale && !gone && !exitHandoff && !untouchedAutoClaim && item.item_status === 'claimed' && item.item_owner === agentId
      && ['BLOCKED', 'BUDGET', 'INELIGIBLE'].includes(reasonCode) : !stale && !gone && !exitHandoff && reasonCode;
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= ROUTE_CALIBRATION_ENGINE && currentEligible
      && ['BUDGET', 'INELIGIBLE'].includes(reasonCode)) {
      const seatRoute = board.db.prepare('SELECT agent_route FROM agent WHERE agent_id=?').get(agentId)?.agent_route;
      if (seatRoute === item.item_route) escalate(board, id, { agentId: 'coordinator', note: `${agentId} released at the ${seatRoute} route: ${reasonCode}${note?.trim() ? ` (${note.trim()})` : ''}` });
    }
    if (!wrongDiagnosis && currentEligible && !item.item_hold_reason
      && (board.executionEngineVersion ?? ENGINE_VERSION) >= RELEASE_TWICE_HOLD_ENGINE) {
      const routeEpisode = (board.executionEngineVersion ?? ENGINE_VERSION) >= RELEASE_TWICE_ROUTE_ENGINE ? lastRouteChange(board, id) : 0;
      const releases = lastChosenReleases(board, id, (row, detail) => row.event_id > routeEpisode && (qualityHolds ? chosenQualityRelease(board, id, row, detail)
        : detail.reasonCode && !detail.untouchedAutoClaim && !detail.review && !detail.staleClaim && !detail.goneSeat && !detail.exitHandoff));
      const route = board.db.prepare('SELECT item_route FROM item WHERE item_id=?').get(id)?.item_route;
      if (releases.length === 2 && (board.executionEngineVersion ?? ENGINE_VERSION) >= RELEASE_TWICE_ROUTE_ENGINE
        && ['light', 'mid'].includes(route)) {
        // A light or mid item moves up one route for any seat there to claim; only a strong item waits for the coordinator.
        const reasons = releases.reverse().map(row => {
          const detail = JSON.parse(row.event_detail);
          return `${row.event_by}: ${detail.reasonCode}${detail.reason ? ` (${detail.reason})` : ''}`;
        }).join('; ');
        escalate(board, id, { agentId: 'coordinator', note: `Released twice at the ${route} route: ${reasons}` });
      } else if (releases.length === 2) {
        const reasons = releases.reverse().map(row => {
          const detail = JSON.parse(row.event_detail);
          return `${row.event_by}: ${detail.reasonCode}${detail.reason ? ` (${detail.reason})` : ''}`;
        }).join('; ');
        const reason = `Released twice: ${reasons}`;
        setItem(board, id, { item_hold_reason: reason, item_hold_by: 'coordinator', item_hold_at: board.clock.now().toISOString() });
        logEvent(board, 'coordinator', 'hold_item', id, { reason, automatic: 'release-twice' });
        insertShout(board, { from: 'sentinel', to: 'coordinator', text: `#${id} held after two releases: ${reasons}`, lanes: [], detail: { item: id } });
      }
    }
    if (stale) insertShout(board, { from: 'sentinel', to: stale.holder,
      text: `Coordinator released your stale claim on #${id}: ${stale.reason.slice(0, 180)}. Last activity ${stale.lastActivity}.`, lanes: [], detail: { item: id } });
    return false;
  });
}
