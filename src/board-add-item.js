import { reviewPolicyChange } from './review-independence.js';
import { saveItemReviewPolicy } from './review-independence.js';
import { twoTierReviews } from './review-independence.js';
import { REFERENCE_ENGINE } from './reference-engine.js';
import { validateReferences } from './reference-authors.js';
import * as reviewFamilies from './required-review-family.js';
import { saveCheckTiming } from './check-timing.js';
import { validateCheckTiming } from './check-timing.js';
import { validateItemDependencies } from './board-item-dependencies.js';
import { validateRehomeCheck } from './board-rehome.js';
import { recordBarRevision } from './bar-readiness.js';
import { normalizeCheckBaseline } from './item-check-baseline.js';
import { saveCheckBaseline } from './item-check-baseline.js';
import { now } from './board-query.js';
import { itemById } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { checkRoute } from './item-routing.js';
import { checkRouted } from './item-routing.js';
import { ENGINE_VERSION } from './machine.js';
import { Refused } from './refused.js';
import * as checkWiden from './check-widen.js';

/**
 * Add an item to a lane, optionally under a parent in the same lane, with a brief for whoever
 * builds it and a route saying who can (B10, B11). The caller has checked the lane and the spec
 * ids (B6).
 *
 * @param {any} board
 * @param {{ by: string, lane: string, title: string, criterion?: string, specIds?: string[], parentId?: number | null, after?: (number | string)[], brief?: string, route?: string, check?: string, checkTiming?: boolean }} item
 * @returns {number} The new item's id.
 */
export function addItem(board, { by, lane, title, criterion = '', specIds = [], parentId = null, after = [], brief = '', route = 'strong', check, checkBaseline, barActor, referenceAuthors, referenceAuthority, sensitive, reviewFamily, checkTiming }) {
  return atomic(board, () => {
    const item = { by, lane, title, criterion, specIds, parentId, after, brief, route, check, checkBaseline, barActor, referenceAuthors, referenceAuthority, sensitive, reviewFamily, checkTiming };
    return insertItem(board, item, validateItemAddition(board, item));
  });
}

/** Insert an already validated ordinary or companion child without bypassing check or bar recording. */
export function insertItem(board, item, { command, cleanTitle }) {
  const { by, lane, criterion, specIds, parentId, after, brief, route, checkBaseline, barActor, reviewFamily } = item;
  const baseline = normalizeCheckBaseline(by, command, checkBaseline);
  const at = now(board);
  const result = board.db
    .prepare(
      `INSERT INTO item (item_parent_id, item_lane, item_title, item_criterion, item_spec_ids,
         item_after, item_brief, item_route, item_check, item_created_by, item_created_at, item_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(parentId, lane, cleanTitle, criterion.trim(), specIds.join(','), after.join(','), brief.trim(), route, command, by, at, at);
  const id = Number(result.lastInsertRowid);
  saveCheckBaseline(board, id, baseline);
  saveCheckTiming(board, id, item.checkTiming);
  const reviewPolicy = twoTierReviews(board) ? reviewPolicyChange(board, null, item) : null;
  saveItemReviewPolicy(board, id, reviewPolicy);
  reviewFamilies.saveReviewFamily(board, id, reviewFamily);
  logEvent(board, by, 'add', id, { lane, specIds, after, route, ...(item.checkTiming === undefined ? {} : { checkTiming: item.checkTiming }), ...(reviewFamily !== undefined && !twoTierReviews(board) ? { reviewFamily: reviewFamily.trim() } : {}), ...(baseline ? { checkBaseline: baseline } : {}), ...(reviewPolicy ? { reviewPolicy } : {}) });
  recordBarRevision(board, itemById(board, id), by, null, barActor);
  return id;
}

/** Validate an addition before its sender runs a new check, and again when the ordered move applies. */
export function validateItemAddition(board, { by, lane, title, criterion = '', parentId = null, after = [], brief = '', route = 'strong', check, referenceAuthors, referenceAuthority, sensitive, reviewFamily, checkTiming }, { sourceMove = null } = {}) {
  const command = sourceMove
    ? validateRehomeCheck(by, check, sourceMove)
    : checkWiden.editCheck(by, check) ?? '';
  validateCheckTiming(board, by, checkTiming);
  reviewPolicyChange(board, null, { sensitive, reviewFamily });
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Refused('NO_TITLE', 'an item needs a title');
  checkRoute(route);
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (engine >= REFERENCE_ENGINE) {
    const proof = sourceMove?.referenceProof;
    validateReferences(brief, { actor: proof?.actor ?? by,
      authors: proof?.authors ?? referenceAuthors, authority: proof?.authority ?? referenceAuthority });
  }
  checkRouted({ brief: brief.trim(), route, criterion, check: command }, engine);
  if (parentId !== null) {
    const parent = itemById(board, parentId);
    if (parent.item_lane !== lane) {
      throw new Refused('PARENT_LANE', `a child item sits in its parent's lane (${parent.item_lane})`);
    }
    if (['verified', 'withdrawn'].includes(parent.item_status)) {
      throw new Refused('PARENT_CLOSED', `item #${parentId} is ${parent.item_status}`);
    }
  }
  validateItemDependencies(board, null, after);
  return { command, cleanTitle };
}
