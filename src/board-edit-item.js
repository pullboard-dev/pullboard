import { notifyFileGrowth as applyFileGrowthNotice } from './item-files.js';
import { reviewPolicyChange } from './review-independence.js';
import { saveItemReviewPolicy } from './review-independence.js';
import { twoTierReviews } from './review-independence.js';
import { REFERENCE_ENGINE } from './reference-engine.js';
import { validateReferences } from './reference-authors.js';
import * as itemDependencies from './item-dependencies.js';
import * as reviewFamilies from './required-review-family.js';
import { itemEditBar } from './item-edit-bar.js';
import { saveCheckTiming } from './check-timing.js';
import { validateCheckTiming } from './check-timing.js';
import { pendingRefreeze } from './board-read-auxiliary.js';
import { validateItemDependencies } from './board-item-dependencies.js';
import { FILE_GROWTH_NOTICE_ENGINE } from './file-growth-notice-engine.js';
import { recordBarRevision } from './bar-readiness.js';
import { normalizeCheckBaseline } from './item-check-baseline.js';
import { saveCheckBaseline } from './item-check-baseline.js';
import { isHeld } from './board-query.js';
import { current } from './board-query.js';
import { itemById } from './board-query.js';
import { listItems } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { checkRoute } from './item-routing.js';
import { checkRouted } from './item-routing.js';
import { COORDINATOR } from './config.js';
import { ENGINE_VERSION } from './machine.js';
import { Refused } from './refused.js';
import { barCorrectionFields } from './bar-corrections.js';
import * as checkWiden from './check-widen.js';
import { moveItem } from './board.js';
import { setItem } from './board.js';
import { insertShout } from './board-shout.js';
import { persistShout } from './board-shout.js';

/**
 * Change an item's brief, route, criterion, check or dependencies (B10, B13, B14). At engine 8 the
 * coordinator may correct a claimed criterion, check or dependency; its holder refreezes before
 * renewal or submission and keeps the claim while adopting the correction.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, brief?: string, route?: string, criterion?: string, check?: string, after?: (number | string)[] }} change
 */
export function editItem(board, id, { agentId, brief, route, criterion, check, after, checkBaseline, reason, barActor, referenceAuthors, referenceAuthority, correction, freeze, sensitive, reviewFamily, reviewTier, checkTiming }) {
  atomic(board, () => {
    const stored = itemById(board, id);
    const expiredHolder = stored.item_status === 'claimed' && !isHeld(board, stored) ? stored.item_owner : null;
    const { item, next, command, unfreeze, bar, widened } = validateItemEdit(board, id, { agentId, brief, route, criterion, check, after, reason, referenceAuthors, referenceAuthority, correction, freeze, sensitive, reviewFamily, reviewTier, checkTiming });
    const reviewPolicy = twoTierReviews(board) ? reviewPolicyChange(board, id, { sensitive, reviewFamily, reviewTier }) : null;
    const baseline = normalizeCheckBaseline(agentId, command, checkBaseline, { authorized: Boolean(widened) });
    const { pendingFields, frozen, pendingRefreeze, clearFrozen } = itemEditBar(board, item, next, { command, agentId, correction, freeze, unfreeze, expiredHolder });
    if (expiredHolder) {
      moveItem(board, id, 'lapse', { checks: {}, set: () => ({ item_owner: null, item_lease_until: null }) });
    }
    const { item_check_timing, ...storedNext } = next;
    saveCheckTiming(board, id, checkTiming);
    setItem(board, id, { ...storedNext, ...(frozen ? { item_frozen: frozen.text, item_frozen_digest: frozen.digest } : {}), ...(clearFrozen ? { item_frozen: null, item_frozen_digest: null } : {}) });
    reviewFamilies.saveReviewFamily(board, id, reviewFamily);
    if (baseline || next.item_check !== item.item_check) saveCheckBaseline(board, id, baseline);
    saveItemReviewPolicy(board, id, reviewPolicy);
    logEvent(board, agentId, 'edit', id, {
      ...(reviewFamily !== undefined && !twoTierReviews(board) ? { reviewFamily: reviewFamily.trim() } : {}),
      ...(reviewPolicy ? { reviewPolicy } : {}),
      ...(next.item_brief !== item.item_brief ? { brief: `${next.item_brief.length} characters` } : {}),
      ...(next.item_route !== item.item_route ? { route: next.item_route } : {}),
      ...(next.item_criterion !== item.item_criterion ? { criterion: next.item_criterion } : {}),
      ...(command !== undefined ? { check: next.item_check } : {}),
      ...(checkTiming === undefined ? {} : { checkTiming }),
      ...(next.item_after !== item.item_after ? { after: itemDependencies.dependencyValues(next) } : {}),
      ...(baseline ? { checkBaseline: baseline } : {}),
      ...(pendingRefreeze ? { pendingRefreeze: pendingFields } : {}),
      ...(frozen ? { correctedFrozen: frozen.digest } : {}),
      ...(clearFrozen && item.item_frozen_digest ? { unfrozen: item.item_frozen_digest } : {}),
      ...(expiredHolder ? { expiredHolder } : {}),
      ...bar,
    });
    recordBarRevision(board, itemById(board, id), agentId, item, barActor);
    notifyFileGrowth(board, item, itemById(board, id));
    if (frozen && item.item_status === 'claimed') insertShout(board, {
      from: COORDINATOR, to: item.item_owner, lanes: [],
      text: `The coordinator corrected #${id}; its frozen criterion and check are effective now. Your claim and lease are retained. Continue with pullboard show ${id}.`,
    });
    if (pendingRefreeze) {
      insertShout(board, {
        from: COORDINATOR,
        to: item.item_owner,
        text: `The coordinator has a pending ${pendingFields.join(' and ')} correction for #${id}; refreeze it before renewing or submitting.\nnext: pullboard refreeze ${id}`,
        lanes: [],
      });
    }
  });
}

/** Bind file-growth delivery to this board's canonical readers and event writers. */
function notifyFileGrowth(board, before, after) {
  return applyFileGrowthNotice(board, before, after, { engineVersion: ENGINE_VERSION, noticeEngine: FILE_GROWTH_NOTICE_ENGINE, coordinator: COORDINATOR, listItems, persistShout, logEvent });
}

/** Validate an edit without side effects, so a refused change never starts a shell baseline; a bar correction needs a reason [B31]. */
export function validateItemEdit(board, id, { agentId, brief, route, criterion, check, after, reason, referenceAuthors, referenceAuthority, sensitive, reviewFamily, reviewTier, checkTiming }) {
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  validateCheckTiming(board, agentId, checkTiming);
  if (after !== undefined && engine < 10) {
    throw new Refused('ENGINE_VERSION', `editing item dependencies requires engine 10; this board uses engine ${engine}; upgrade Pullboard before using --after`);
  }
  if (reviewTier !== undefined) {
    if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator marks strict review; ask the coordinator to edit this item with --review-tier strict --reason');
    if (typeof reason !== 'string' || !reason.trim()) throw new Refused('BAR_REASON', 'marking strict review needs --reason explaining the gate judgment or independence risk');
  }
  let item = (board.executionEngineVersion ?? ENGINE_VERSION) >= 8 ? current(board, itemById(board, id)) : null;
  const widened = item && checkWiden.selfWidenedFiles(board, item, agentId, { brief, route, criterion, check, after, sensitive, reviewFamily, reviewTier, checkTiming });
  if (item?.item_status === 'claimed' && agentId !== COORDINATOR && !widened) {
    throw new Refused('HELD', `item #${id} is claimed; only the coordinator may edit it while held; shout coordinator`);
  }
  const command = checkWiden.editCheck(agentId, check, widened);
  if ([brief, route, criterion, check, after, sensitive, reviewFamily, reviewTier, checkTiming].every((value) => value === undefined)) {
    throw new Refused('USAGE', 'say what changes: --brief "...", --brief-file <file>, --route light|mid|strong, --criterion "...", --check "<command>" or --after <ids|none>');
  }
  item ??= current(board, itemById(board, id));
  if (agentId !== COORDINATOR && agentId !== item.item_created_by && !widened) {
    throw new Refused('NOT_YOURS', `only the coordinator or ${item.item_created_by}, who added #${id}, edits it; shout them instead`);
  }
  if (['verified', 'withdrawn'].includes(item.item_status)) {
    throw new Refused('CLOSED', `item #${id} is ${item.item_status}`);
  }
  const reviewPolicy = reviewPolicyChange(board, id, { sensitive, reviewFamily, reviewTier });
  if ((sensitive !== undefined || reviewFamily !== undefined) && reviewPolicy && item.item_status !== 'open') throw new Refused('HELD', `item #${id} is ${item.item_status}; change its review policy only while it is open`);
  if (after !== undefined) {
    if (!Array.isArray(after)) {
      throw new Refused('BAD_DEPENDENCIES', 'item dependencies must be an array of positive integer item ids; use --after 1,2 or --after none');
    }
    itemDependencies.validateNativeDependencies(after);
    validateItemDependencies(board, id, after);
  }
  const next = {
    item_brief: brief === undefined ? item.item_brief : brief.trim(),
    item_route: route ?? item.item_route,
    item_criterion: criterion === undefined ? item.item_criterion : criterion.trim(),
    item_check: command === undefined ? item.item_check : command,
    ...(checkTiming === undefined && item.item_check_timing === undefined ? {} : { item_check_timing: checkTiming ?? item.item_check_timing }),
    item_after: after === undefined ? item.item_after : after.join(','),
  };
  checkRoute(next.item_route);
  const moved = ['item_route', 'item_criterion', 'item_check', 'item_after', 'item_check_timing'].filter((key) => next[key] !== item[key]);
  const correctionWhileClaimed = (board.executionEngineVersion ?? ENGINE_VERSION) >= 8
    && item.item_status === 'claimed' && (agentId === COORDINATOR || widened)
    && (next.item_criterion !== item.item_criterion || next.item_check !== item.item_check || next.item_after !== item.item_after || next.item_check_timing !== item.item_check_timing);
  if (moved.length && item.item_status !== 'open' && (next.item_route !== item.item_route || !correctionWhileClaimed)) {
    throw new Refused('HELD', `item #${id} is ${item.item_status}; change its route, criterion or check only while it is open`);
  }
  if (brief !== undefined && engine >= REFERENCE_ENGINE) validateReferences(brief, { actor: agentId, authors: referenceAuthors, authority: referenceAuthority, previous: item.item_brief });
  checkRouted({ brief: next.item_brief, route: next.item_route, criterion: next.item_criterion, check: next.item_check }, engine);
  const unfreeze = next.item_criterion !== item.item_criterion || next.item_check !== item.item_check || next.item_check_timing !== item.item_check_timing || Boolean(reviewPolicy) && (sensitive !== undefined || reviewFamily !== undefined);
  return { item, next, command, unfreeze, bar: barCorrectionFields(board, item, next, { reason, widened }), widened: widened || null };
}
