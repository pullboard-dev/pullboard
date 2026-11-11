import * as deferOwnership from './ownership.js';
import * as queueSubmitHandoff from './handoff.js';
import * as applyRowDecisions from '../../../logic/engine/move/decisions.js';
import * as advanceItemSource from '../../../logic/engine/move/source.js';
import * as answerDecision from '../../../logic/engine/move/decision.js';
import * as appendFact from '../../../logic/engine/move/fact.js';
import * as claim from '../../../logic/engine/move/claim.js';
import * as editItem from '../../../logic/engine/move/edit/item.js';
import * as editMilestone from '../../../logic/engine/move/edit/milestone.js';
import * as followItemPatches from '../../../logic/engine/move/patches.js';
import * as itemPatch from '../../../logic/engine/move/patch.js';
import * as recordGateRun from '../../../logic/engine/move/record/run/gate.js';
import * as recordHealthFindings from '../../../logic/engine/move/record/findings.js';
import * as recordProofRun from '../../../logic/engine/move/record/run/proof.js';
import * as recordTrainLanding from '../../../logic/engine/move/record/landing.js';
import * as refreeze from '../../../logic/engine/move/refreeze.js';
import * as rehomeItem from '../../../logic/engine/move/rehome.js';
import * as release from '../../../logic/engine/move/release.js';
import * as reopen from '../../../logic/engine/move/reopen.js';
import * as submit from './submit.js';
import * as verify from '../../../logic/engine/move/verify.js';

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
