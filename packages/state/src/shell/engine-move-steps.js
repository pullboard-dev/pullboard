import * as deferOwnership from './engine-move-defer-ownership.js';
import * as queueSubmitHandoff from './engine-move-queue-submit-handoff.js';
import * as applyRowDecisions from '../core/engine-move-apply-row-decisions.js';
import * as advanceItemSource from '../core/engine-move-advance-item-source.js';
import * as answerDecision from '../core/engine-move-answer-decision.js';
import * as appendFact from '../core/engine-move-append-fact.js';
import * as claim from '../core/engine-move-claim.js';
import * as editItem from '../core/engine-move-edit-item.js';
import * as editMilestone from '../core/engine-move-edit-milestone.js';
import * as followItemPatches from '../core/engine-move-follow-item-patches.js';
import * as itemPatch from '../core/engine-move-item-patch.js';
import * as recordGateRun from '../core/engine-move-record-gate-run.js';
import * as recordHealthFindings from '../core/engine-move-record-health-findings.js';
import * as recordProofRun from '../core/engine-move-record-proof-run.js';
import * as recordTrainLanding from '../core/engine-move-record-train-landing.js';
import * as refreeze from '../core/engine-move-refreeze.js';
import * as rehomeItem from '../core/engine-move-rehome-item.js';
import * as release from '../core/engine-move-release.js';
import * as reopen from '../core/engine-move-reopen.js';
import * as submit from './engine-move-submit.js';
import * as verify from '../core/engine-move-verify.js';

/**
 * Each operation's own sealing and replay steps, one module per operation, so the engine keeps only
 * the shared skeleton [C7,H16]. A module may export prepareArgs (before the arguments are copied),
 * prepareBefore (before the engine floor check), prepareAfter (after it) and replayArgs (when a
 * receiver restores the sealed arguments), validate (after wire identity validation), or replayBefore
 * (before replay installs its clock or records any receipt); an operation without a module seals its arguments as given.
 */
export const ENGINE_MOVE_STEPS = Object.freeze({
  deferOwnership,
  queueSubmitHandoff,
  advanceItemSource,
  answerDecision,
  applyRowDecisions,
  appendFact,
  attachItemPatch: itemPatch,
  claim,
  editItem,
  editMilestone,
  followItemPatches,
  recordGateRun,
  recordHealthFindings,
  recordProofRun,
  recordTrainLanding,
  refreeze,
  rehomeItem,
  release,
  removeItemPatch: itemPatch,
  reopen,
  submit,
  verify,
});
