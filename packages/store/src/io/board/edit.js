import { lightDiagnosisProblem } from '../../logic/item/diagnosis.js';
import { CLAUSE_EVIDENCE_ENGINE } from '../../../../state/index.js';
import { requireCriterionEvidence } from '../../../../state/index.js';
import { saveExpectedBuildMinutes } from '../expected.js';
import { saveReadinessCommand } from '../readiness.js';
import { validateReadinessCommand } from '../readiness.js';
import { saveItemNeeds } from '../needs.js';
import { validateItemNeeds } from '../needs.js';
import { NEEDS_ENGINE } from '../../../../state/light.js';
import { READINESS_ENGINE } from '../../../../state/light.js';
import { validateExpectedBuildMinutes } from '../../../../items/index.js';
import { EXPECTED_BUILD_ENGINE } from '../../../../state/light.js';
import { validateMachineVerification } from '../../../../verify/index.js';
import { saveMachineVerification } from '../../../../verify/index.js';
import { createHash } from 'node:crypto';
import { notifyFileGrowth as applyFileGrowthNotice } from "../../../../items/index.js";
import { reviewPolicyChange } from "../../../../verify/index.js";
import { saveItemReviewPolicy } from "../../../../verify/index.js";
import { twoTierReviews } from "../../../../verify/index.js";
import { REFERENCE_ENGINE } from "../../../../state/light.js";
import { validateReferences } from "../../../../spec/index.js";
import * as itemDependencies from "../../../../items/index.js";
import { editCheck } from "../../../../verify/index.js";
import { saveReviewFamily } from "../../../../verify/index.js";
import { selfWidenedFiles } from "../../../../verify/index.js";
import { itemEditBar } from "../../../../items/index.js";
import { saveCheckTiming } from "../../../../items/light.js";
import { validateCheckTiming } from "../../../../items/light.js";
import { pendingRefreeze } from "./read/shouts.js";
import { validateItemDependencies } from "./item/dependencies.js";
import { afterGateIds } from "./item/after-gate.js";
import { setAfterGate } from "./item/after-gate.js";
import { FILE_GROWTH_NOTICE_ENGINE } from "../../../../state/light.js";
import { recordBarRevision } from "../../../../verify/index.js";
import { normalizeCheckBaseline } from "../baseline/check.js";
import { saveCheckBaseline } from "../baseline/check.js";
import { isHeld } from "./query.js";
import { current } from "./query.js";
import { itemById } from "./query.js";
import { listItems } from "./query.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { checkRoute } from "../../../../items/index.js";
import { checkRouted } from "../../../../items/index.js";
import { stripPerItemFullSuiteCriterion } from "../../../../items/index.js";
import { PER_ITEM_FULL_SUITE_ENGINE } from "../../../../state/light.js";
import { COORDINATOR } from "../../../../config/index.js";
import { loadConfig } from "../../../../config/index.js";
import { requireOwnLaneCheck } from "../../../../verify/index.js";
import { laneOf } from "../../../../seats/index.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { Refused } from "../../../../kernel/index.js";
import { barCorrectionFields } from "../../../../verify/index.js";
import { moveItem } from "../board.js";
import { setItem } from "../board.js";
import { insertShout } from "./shout.js";
import { persistShout } from "./shout.js";

/**
 * Change an item's brief, route, criterion, check or dependencies (B10, B13, B14). At engine 8 the
 * coordinator may correct a claimed criterion, check or dependency; its holder refreezes before
 * renewal or submission and keeps the claim while adopting the correction.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, brief?: string, route?: string, criterion?: string, check?: string, after?: (number | string)[], afterGate?: number[] }} change
 */
export function editItem(board, id, { agentId, title, brief, route, criterion, check, after, afterGate, specs, checkBaseline, reason, barActor, referenceAuthors, referenceAuthority, correction, freeze, sensitive, reviewFamily, reviewTier, checkTiming, machineVerified, machineCommands, expectedBuildMinutes, readinessCommand, needs, preserveFrozen = false }) {
  if (preserveFrozen && (agentId !== COORDINATOR || reason !== 'S10 full-suite strip' || criterion === undefined
    || brief !== undefined || route !== undefined || check !== undefined || after !== undefined || afterGate !== undefined || checkBaseline !== undefined
    || correction !== undefined || freeze !== undefined || sensitive !== undefined || reviewFamily !== undefined
    || reviewTier !== undefined || checkTiming !== undefined || expectedBuildMinutes !== undefined || readinessCommand !== undefined || needs !== undefined
    || barActor !== undefined || referenceAuthors !== undefined || referenceAuthority !== undefined)) {
    throw new Refused('COORDINATOR_ONLY', 'preserving a frozen bar is limited to the coordinator’s exact S10 criterion strip');
  }
  atomic(board, () => {
    const stored = itemById(board, id);
    const expiredHolder = stored.item_status === 'claimed' && !isHeld(board, stored) ? stored.item_owner : null;
    const { item, next, command, unfreeze, bar, widened, evidenceWarnings } = validateItemEdit(board, id, { agentId, title, brief, route, criterion, check, after, afterGate, specs, reason, referenceAuthors, referenceAuthority, correction, freeze, sensitive, reviewFamily, reviewTier, checkTiming, machineVerified, machineCommands, expectedBuildMinutes, readinessCommand, needs, preserveFrozen });
    if (preserveFrozen) {
      const engine = board.executionEngineVersion ?? ENGINE_VERSION;
      const stripped = stripPerItemFullSuiteCriterion(item.item_criterion);
      if (engine < PER_ITEM_FULL_SUITE_ENGINE) throw new Refused('ENGINE_VERSION', `S10 bar preservation requires engine ${PER_ITEM_FULL_SUITE_ENGINE}; upgrade Pullboard`);
      if (!stripped.removed.length || stripped.criterion !== next.item_criterion || criterion !== next.item_criterion) {
        throw new Refused('S10', 'a frozen bar can be preserved only when this edit removes exactly its full-suite or CI clause');
      }
    }
    const reviewPolicy = twoTierReviews(board) ? reviewPolicyChange(board, id, { sensitive, reviewFamily, reviewTier }) : null;
    const baseline = normalizeCheckBaseline(agentId, command, checkBaseline, { authorized: Boolean(widened) });
    const { pendingFields, frozen, pendingRefreeze, clearFrozen } = itemEditBar(board, item, next, { command, agentId, correction, freeze, unfreeze, expiredHolder, preserveFrozen,
      sha256: text => createHash('sha256').update(text).digest('hex') });
    if (expiredHolder) {
      moveItem(board, id, 'lapse', { checks: {}, set: () => ({ item_owner: null, item_lease_until: null }) });
    }
    const { item_check_timing, ...storedNext } = next;
    // A coordinator removing prerequisites also removes the corresponding blocked-release wait.
    if (after !== undefined) {
      const marker = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`blocked_release_waiting:${id}`);
      const waiting = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`claim_waiting:${id}`);
      if (marker) {
        const retained = JSON.parse(marker.meta_value).filter(value => after.includes(value));
        board.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify(retained), `blocked_release_waiting:${id}`);
      }
      if (waiting) {
        const retained = JSON.parse(waiting.meta_value).filter(value => after.includes(value));
        board.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify(retained), `claim_waiting:${id}`);
      }
    }
    saveCheckTiming(board, id, checkTiming);
    saveExpectedBuildMinutes(board, id, expectedBuildMinutes);
    saveReadinessCommand(board, id, readinessCommand);
    saveItemNeeds(board, id, needs);
    setItem(board, id, { ...storedNext, ...(frozen ? { item_frozen: frozen.text, item_frozen_digest: frozen.digest } : {}), ...(clearFrozen ? { item_frozen: null, item_frozen_digest: null } : {}) });
    saveReviewFamily(board, id, reviewFamily);
    // A new plain --after list keeps the after-gate ids the item already waits on.
    if (afterGate !== undefined) setAfterGate(board, id, afterGate);
    else if (after !== undefined && afterGateIds(board, id).length) setAfterGate(board, id, afterGateIds(board, id));
    if (baseline || next.item_check !== item.item_check) saveCheckBaseline(board, id, baseline);
    saveItemReviewPolicy(board, id, reviewPolicy);
    const machineVerification = saveMachineVerification(board, { ...item, ...next }, { agentId, machineVerified, machineCommands });
    if (machineVerification) setItem(board, id, { item_frozen: null, item_frozen_digest: null });
    logEvent(board, agentId, 'edit', id, {
      ...(evidenceWarnings.length ? { criterionEvidenceWarnings: evidenceWarnings } : {}),
      ...(machineVerification ? { machineVerification } : {}),
      ...(reviewFamily !== undefined && !twoTierReviews(board) ? { reviewFamily: reviewFamily.trim() } : {}),
      ...(reviewPolicy ? { reviewPolicy } : {}),
      ...(next.item_title !== item.item_title ? { title: next.item_title, previousTitle: item.item_title } : {}),
      ...(next.item_brief !== item.item_brief ? { brief: `${next.item_brief.length} characters` } : {}),
      ...(next.item_route !== item.item_route ? { route: next.item_route } : {}),
      ...(next.item_criterion !== item.item_criterion ? { criterion: next.item_criterion } : {}),
      ...(next.item_criterion !== item.item_criterion && reason === 'S10 full-suite strip' ? { previousCriterion: item.item_criterion } : {}),
      ...(command !== undefined ? { check: next.item_check } : {}),
      ...(checkTiming === undefined ? {} : { checkTiming }),
      ...(expectedBuildMinutes === undefined ? {} : { expectedBuildMinutes }),
      ...(readinessCommand === undefined ? {} : { readinessCommand: readinessCommand.trim() }),
      ...(needs === undefined ? {} : { needs }),
      ...(next.item_after !== item.item_after ? { after: itemDependencies.dependencyValues(next) } : {}),
      ...(next.item_spec_ids !== item.item_spec_ids ? { specIds: specs, previousSpecIds: item.item_spec_ids ? item.item_spec_ids.split(',') : [] } : {}),
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
export function validateItemEdit(board, id, { agentId, title, brief, route, criterion, check, after, afterGate, specs, reason, referenceAuthors, referenceAuthority, sensitive, reviewFamily, reviewTier, checkTiming, machineVerified, machineCommands, expectedBuildMinutes, readinessCommand, needs, preserveFrozen = false }) {
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  validateCheckTiming(board, agentId, checkTiming);
  validateItemNeeds(needs);
  if (needs !== undefined && engine < NEEDS_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before authoring item needs');
  validateReadinessCommand(readinessCommand);
  if (readinessCommand !== undefined && engine < READINESS_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before authoring a readiness command');
  validateExpectedBuildMinutes(expectedBuildMinutes);
  if (expectedBuildMinutes !== undefined && engine < EXPECTED_BUILD_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before authoring expected build time');
  validateMachineVerification(board, { ...itemById(board, id), ...(criterion === undefined ? {} : { item_criterion: criterion }), ...(check === undefined ? {} : { item_check: check }) }, { agentId, machineVerified, machineCommands });
  if (after !== undefined && engine < 10) {
    throw new Refused('ENGINE_VERSION', `editing item dependencies requires engine 10; this board uses engine ${engine}; upgrade Pullboard before using --after`);
  }
  if (reviewTier !== undefined) {
    if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator marks strict review; ask the coordinator to edit this item with --review-tier strict --reason');
    if (typeof reason !== 'string' || !reason.trim()) throw new Refused('BAR_REASON', 'marking strict review needs --reason explaining the gate judgment or independence risk');
  }
  let item = (board.executionEngineVersion ?? ENGINE_VERSION) >= 8 ? current(board, itemById(board, id)) : null;
  const widened = item && selfWidenedFiles(board, item, agentId, { brief, route, criterion, check, after, sensitive, reviewFamily, reviewTier, checkTiming });
  if (item?.item_status === 'claimed' && agentId !== COORDINATOR && !widened) {
    throw new Refused('HELD', `item #${id} is claimed; only the coordinator may edit it while held; shout coordinator`);
  }
  const command = editCheck(agentId, check, widened);
  if (title !== undefined && (typeof title !== 'string' || !title.trim())) throw new Refused('USAGE', 'the new title cannot be empty: pass --title "the new title"');
  if ([title, brief, route, criterion, check, after, afterGate, specs, sensitive, reviewFamily, reviewTier, checkTiming, machineVerified, machineCommands, expectedBuildMinutes, readinessCommand, needs].every((value) => value === undefined)) {
    throw new Refused('USAGE', 'say what changes: --brief "...", --title "...", --brief-file <file>, --route light|mid|strong, --criterion "...", --check "<command>", --after <ids|none> or --expected-minutes <minutes|unknown>');
  }
  item ??= current(board, itemById(board, id));
  if (check !== undefined && board.gitRoot && agentId !== COORDINATOR) {
    const actor = board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id = ?').get(agentId);
    requireOwnLaneCheck(loadConfig(board.gitRoot), { id: agentId, lane: actor?.agent_lane }, item.item_lane, command, laneOf);
  }
  if (agentId !== COORDINATOR && agentId !== item.item_created_by && !widened) {
    throw new Refused('NOT_YOURS', `only the coordinator or ${item.item_created_by}, who added #${id}, edits it; shout them instead`);
  }
  if (specs !== undefined) {
    if (!Array.isArray(specs) || !specs.length || specs.some(id => typeof id !== 'string' || !id.trim() || id.includes(',')) || new Set(specs).size !== specs.length) {
      throw new Refused('BAD_SPECS', 'spec rows are a nonempty list of distinct row ids: pullboard edit <id> --specs G1,G2 --reason "..."');
    }
    if (typeof reason !== 'string' || !reason.trim()) throw new Refused('BAR_REASON', 'replacing the cited spec rows needs --reason saying why the old rows were wrong');
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
    validateItemDependencies(board, id, [...after, ...(afterGate ?? afterGateIds(board, id))]);
  } else if (afterGate !== undefined) {
    itemDependencies.validateNativeDependencies(afterGate);
    validateItemDependencies(board, id, [...itemDependencies.dependencyValues(item.item_after), ...afterGate]);
  }
  const next = {
    item_title: title === undefined ? item.item_title : title.trim(),
    item_brief: brief === undefined ? item.item_brief : brief.trim(),
    item_route: route ?? item.item_route,
    item_criterion: criterion === undefined ? item.item_criterion : criterion.trim(),
    item_check: command === undefined ? item.item_check : command,
    ...(checkTiming === undefined && item.item_check_timing === undefined ? {} : { item_check_timing: checkTiming ?? item.item_check_timing }),
    item_after: after === undefined ? item.item_after : after.join(','),
    item_spec_ids: specs === undefined ? item.item_spec_ids : specs.map(id => id.trim()).join(','),
  };
  const evidenceWarnings = criterion !== undefined && engine >= CLAUSE_EVIDENCE_ENGINE ? requireCriterionEvidence(next.item_criterion) : [];
  checkRoute(next.item_route);
  const diagnosisProblem = lightDiagnosisProblem(board, { ...item, ...next });
  if (diagnosisProblem) throw diagnosisProblem;
  const moved = ['item_route', 'item_criterion', 'item_check', 'item_after', 'item_check_timing', 'item_spec_ids'].filter((key) => next[key] !== item[key]);
  const correctionWhileClaimed = (board.executionEngineVersion ?? ENGINE_VERSION) >= 8
    && item.item_status === 'claimed' && (agentId === COORDINATOR || widened)
    && (next.item_criterion !== item.item_criterion || next.item_check !== item.item_check || next.item_after !== item.item_after || next.item_check_timing !== item.item_check_timing || next.item_spec_ids !== item.item_spec_ids);
  const preservingSubmittedCriterion = preserveFrozen && agentId === COORDINATOR && reason === 'S10 full-suite strip'
    && item.item_status === 'submitted' && next.item_criterion !== item.item_criterion;
  if (moved.length && item.item_status !== 'open' && (next.item_route !== item.item_route || !correctionWhileClaimed && !preservingSubmittedCriterion)) {
    throw new Refused('HELD', `item #${id} is ${item.item_status}; change its route, criterion or check only while it is open`);
  }
  if (brief !== undefined && engine >= REFERENCE_ENGINE) validateReferences(brief, { actor: agentId, authors: referenceAuthors, authority: referenceAuthority, previous: item.item_brief });
  checkRouted({ brief: next.item_brief, route: next.item_route, criterion: next.item_criterion, check: next.item_check }, engine);
  const unfreeze = next.item_criterion !== item.item_criterion || next.item_check !== item.item_check || next.item_check_timing !== item.item_check_timing || next.item_spec_ids !== item.item_spec_ids || Boolean(reviewPolicy) && (sensitive !== undefined || reviewFamily !== undefined);
  return { item, next, command, unfreeze, evidenceWarnings, bar: barCorrectionFields(board, item, next, { reason, widened }), widened: widened || null };
}
