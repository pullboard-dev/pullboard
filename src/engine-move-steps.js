import * as applyRowDecisions from './engine-move-apply-row-decisions.js';
import * as advanceItemSource from './engine-move-advance-item-source.js';
import * as answerDecision from './engine-move-answer-decision.js';
import * as appendFact from './engine-move-append-fact.js';
import * as claim from './engine-move-claim.js';
import * as editItem from './engine-move-edit-item.js';
import * as editMilestone from './engine-move-edit-milestone.js';
import * as followItemPatches from './engine-move-follow-item-patches.js';
import * as itemPatch from './engine-move-item-patch.js';
import * as recordGateRun from './engine-move-record-gate-run.js';
import * as recordHealthFindings from './engine-move-record-health-findings.js';
import * as recordProofRun from './engine-move-record-proof-run.js';
import * as recordTrainLanding from './engine-move-record-train-landing.js';
import * as refreeze from './engine-move-refreeze.js';
import * as rehomeItem from './engine-move-rehome-item.js';
import * as release from './engine-move-release.js';
import * as reopen from './engine-move-reopen.js';
import * as submit from './engine-move-submit.js';
import * as verify from './engine-move-verify.js';

/**
 * Each operation's own sealing and replay steps, one module per operation, so the engine keeps only
 * the shared skeleton [C7,H16]. A module may export prepareArgs (before the arguments are copied),
 * prepareBefore (before the engine floor check), prepareAfter (after it) and replayArgs (when a
 * receiver restores the sealed arguments), validate (after wire identity validation), or replayBefore
 * (before replay installs its clock or records any receipt); an operation without a module seals its arguments as given.
 */
export const ENGINE_MOVE_STEPS = Object.freeze({
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
