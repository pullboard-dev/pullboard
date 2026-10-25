/** A completed durable move must never be repeated because later command work refused [C6,N26]. */
import { Refused } from './refused.js';

/** Remove only advice to repeat this original command, retaining named pairing, key and recovery actions. */
function recordedRecovery(text) {
  return text?.replace(/run this command where the key is available, or pair this device/gu, 'restore access to the key or pair this device')
    .replace(/then retry with PULLBOARD_RELAY_TOKEN/gu, 'then use PULLBOARD_RELAY_TOKEN for later work')
    .replace(/\b(?:run|retry|repeat) (?:the |this |original )?(?:command|move)(?: again)?\b/giu, 'inspect the recorded work with pullboard status')
    .replace(/\brun it again once the relay answers\b/giu, 'inspect the recorded work once the relay answers');
}
/** Preserve actionable storage/auth recovery; only transient transport retry instructions get replaced. */
export function recordedMoveRefusal(io, error) {
  if (!io.recordedMove || !(error instanceof Refused) || !/^(?:RELAY_|AUTH_|TOKEN_)/u.test(error.code)) return error;
  const recorded = 'a move from this command was already recorded; any pending relay work remains queued locally; do not repeat the original command';
  const next = 'run pullboard status to inspect the recorded work and pending relay sync; do not repeat the original command';
  const unsafeRetry = /\b(?:run|retry|repeat) (?:the |this |original )?(?:command|move)(?: again)?\b/iu.test(error.message + ' ' + (error.next ?? ''));
  if (['RELAY_BUSY', 'RELAY_UNAVAILABLE', 'RELAY_RESPONSE'].includes(error.code) && unsafeRetry) return new Refused(error.code, recorded, next);
  return new Refused(error.code, recordedRecovery(error.message.replace(/^\[[A-Z0-9_]+\] /u, '')) + '; ' + recorded,
    recordedRecovery(error.next) ?? next);
}

/** Match the actual parsed command's requested effects, excluding check attempts and other preflight bookkeeping. */
export function requestedCommandMove(command, operation) {
  if (!command) return false;
  const forms = {
    add: ['addItem'], edit: ['editItem'], merged: ['merged'], submit: ['submit'],
    claim: ['claim'], release: ['release'], verify: ['verify'], withdraw: ['withdraw', 'editMilestoneItems'],
    refreeze: ['refreeze'], reopen: ['reopen'], escalate: ['escalate', 'shout'],
    next: ['claim', 'reserveReview', 'reserveNextReview'], run: ['claim', 'release', 'submit', 'reserveReview', 'reserveNextReview', 'verify', 'escalate', 'shout'],
    init: ['register'], join: ['register'], worktree: ['register'], takeover: ['takeCoordinator'],
    relay: ['setBoardMembers'],
    inbox: ['recordActivityDelivery', 'actOnActivity'],
    shout: ['shout'], answer: ['answerDecision'], pass: ['passDecision'], fact: ['appendFact'],
    hold: ['holdLane', 'releaseLane', 'holdItem', 'releaseItemHold'],
    bar: ['setBarReady', 'signBar'], settings: ['setLineSetting', 'setPersonSigning'], check: ['acceptCheck'],
    spec: ['recordRowDecisions', 'decideSpecRevisions', 'applyRowDecisions', 'draftSpecRow', 'appendFact', 'editItem', 'withdraw'],
    blueprint: ['draftSpecRow', 'addItem', 'appendFact'], rigor: ['draftSpecRow', 'proposeSentinel'], sweep: ['addItem'],
    milestone: ['addMilestone', 'editMilestoneItems', 'orderMilestoneItems', 'moveMilestone', 'editMilestone', 'removeMilestone', 'shipMilestone'],
    land: ['recordLandingBatch', 'recordLandingWaiver', 'finishLandingBatch'],
    sentinel: ['proposeSentinel', 'decideSentinel', 'beginSentinelRun', 'finishSentinelRun', 'recordHealthFindings'],
    flakes: ['recordFlakeObservation'], loop: ['declareJob', 'recordJobRun'],
    intake: ['intakeOutside', 'approveOutside'], publish: ['recordPublishFinding'],
  };
  return Object.hasOwn(forms, command) && forms[command].includes(operation);
}
