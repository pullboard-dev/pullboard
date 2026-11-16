import { lightDiagnosisProblem } from '../../logic/item/diagnosis.js';
import { CLAUSE_EVIDENCE_ENGINE } from '../../../../state/index.js';
import { requireCriterionEvidence } from '../../../../state/index.js';
import { saveExpectedBuildMinutes } from '../expected.js';
import { saveReadinessCommand } from '../readiness.js';
import { validateReadinessCommand } from '../readiness.js';
import { READINESS_ENGINE } from '../../../../state/light.js';
import { validateExpectedBuildMinutes } from '../../../../items/index.js';
import { EXPECTED_BUILD_ENGINE } from '../../../../state/light.js';
import { reviewPolicyChange } from "../../../../verify/index.js";
import { saveItemReviewPolicy } from "../../../../verify/index.js";
import { twoTierReviews } from "../../../../verify/index.js";
import { REFERENCE_ENGINE } from "../../../../state/light.js";
import { validateReferences } from "../../../../spec/index.js";
import { editCheck } from "../../../../verify/index.js";
import { saveReviewFamily } from "../../../../verify/index.js";
import { saveCheckTiming } from "../../../../items/light.js";
import { validateCheckTiming } from "../../../../items/light.js";
import { validateItemDependencies } from "./item/dependencies.js";
import { validateRehomeCheck } from "./facade.js";
import { recordBarRevision } from "../../../../verify/index.js";
import { normalizeCheckBaseline } from "../baseline/check.js";
import { saveCheckBaseline } from "../baseline/check.js";
import { now } from "./query.js";
import { itemById } from "./query.js";
import { atomic } from "./event/log.js";
import { placeNewItem } from "./milestones.js";
import { logEvent } from "./event/log.js";
import { checkRoute } from "../../../../items/index.js";
import { checkRouted } from "../../../../items/index.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { Refused } from "../../../../kernel/index.js";
import { COORDINATOR } from "../../../../config/index.js";
import { loadConfig } from "../../../../config/index.js";
import { requireOwnLaneCheck } from "../../../../verify/index.js";
import { laneOf } from "../../../../seats/index.js";

/**
 * Add an item to a lane, optionally under a parent in the same lane, with a brief for whoever
 * builds it and a route saying who can (B10, B11). The caller has checked the lane and the spec
 * ids (B6).
 *
 * @param {any} board
 * @param {{ by: string, lane: string, title: string, criterion?: string, specIds?: string[], parentId?: number | null, after?: (number | string)[], brief?: string, route?: string, check?: string, checkTiming?: boolean }} item
 * @returns {number} The new item's id.
 */
export function addItem(board, { by, lane, title, criterion = '', specIds = [], parentId = null, after = [], brief = '', route = 'strong', check, checkBaseline, barActor, referenceAuthors, referenceAuthority, sensitive, reviewFamily, checkTiming, expectedBuildMinutes, readinessCommand }) {
  return atomic(board, () => {
    const item = { by, lane, title, criterion, specIds, parentId, after, brief, route, check, checkBaseline, barActor, referenceAuthors, referenceAuthority, sensitive, reviewFamily, checkTiming, expectedBuildMinutes, readinessCommand };
    const id = insertItem(board, item, validateItemAddition(board, item));
    placeNewItem(board, id, item);
    return id;
  });
}

/** Insert an already validated ordinary or companion child without bypassing check or bar recording. */
export function insertItem(board, item, { command, cleanTitle, brief: normalizedBrief = item.brief, evidenceWarnings = [] }) {
  const { by, lane, criterion, specIds, parentId, after, route, checkBaseline, barActor, reviewFamily } = item;
  const brief = normalizedBrief;
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
  saveExpectedBuildMinutes(board, id, item.expectedBuildMinutes);
  saveReadinessCommand(board, id, item.readinessCommand);
  const reviewPolicy = twoTierReviews(board) ? reviewPolicyChange(board, null, item) : null;
  saveItemReviewPolicy(board, id, reviewPolicy);
  saveReviewFamily(board, id, reviewFamily);
  logEvent(board, by, 'add', id, { lane, specIds, after, route, ...(evidenceWarnings.length ? { criterionEvidenceWarnings: evidenceWarnings } : {}), ...(item.expectedBuildMinutes === undefined ? {} : { expectedBuildMinutes: item.expectedBuildMinutes }), ...(item.readinessCommand === undefined ? {} : { readinessCommand: item.readinessCommand.trim() }), ...(item.checkTiming === undefined ? {} : { checkTiming: item.checkTiming }), ...(reviewFamily !== undefined && !twoTierReviews(board) ? { reviewFamily: reviewFamily.trim() } : {}), ...(baseline ? { checkBaseline: baseline } : {}), ...(reviewPolicy ? { reviewPolicy } : {}) });
  recordBarRevision(board, itemById(board, id), by, null, barActor);
  return id;
}

/** Validate an addition before its sender runs a new check, and again when the ordered move applies. */
export function validateItemAddition(board, { by, lane, title, criterion = '', parentId = null, after = [], brief = '', route = 'strong', check, referenceAuthors, referenceAuthority, sensitive, reviewFamily, checkTiming, expectedBuildMinutes, readinessCommand }, { sourceMove = null } = {}) {
  const command = sourceMove
    ? validateRehomeCheck(by, check, sourceMove)
    : editCheck(by, check) ?? '';
  if (board.gitRoot && by !== COORDINATOR) {
    const actor = board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id = ?').get(by);
    requireOwnLaneCheck(loadConfig(board.gitRoot), { id: by, lane: actor?.agent_lane }, lane, command, laneOf);
  }
  validateCheckTiming(board, by, checkTiming);
  validateExpectedBuildMinutes(expectedBuildMinutes);
  if (expectedBuildMinutes !== undefined && (board.executionEngineVersion ?? ENGINE_VERSION) < EXPECTED_BUILD_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before authoring expected build time');
  validateReadinessCommand(readinessCommand);
  if (readinessCommand !== undefined && (board.executionEngineVersion ?? ENGINE_VERSION) < READINESS_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before authoring a readiness command');
  reviewPolicyChange(board, null, { sensitive, reviewFamily });
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Refused('NO_TITLE', 'an item needs a title');
  checkRoute(route);
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  const evidenceWarnings = engine >= CLAUSE_EVIDENCE_ENGINE ? requireCriterionEvidence(criterion) : [];
  if (engine >= REFERENCE_ENGINE) {
    const proof = sourceMove?.referenceProof;
    validateReferences(brief, { actor: proof?.actor ?? by,
      authors: proof?.authors ?? referenceAuthors, authority: proof?.authority ?? referenceAuthority });
  }
  const diagnosisProblem = lightDiagnosisProblem(board, { item_route: route, item_brief: brief });
  if (diagnosisProblem) throw diagnosisProblem;
  const normalizedBrief = checkRouted({ brief: brief.trim(), route, criterion, check: command }, engine);
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
  return { command, cleanTitle, brief: normalizedBrief, evidenceWarnings };
}
