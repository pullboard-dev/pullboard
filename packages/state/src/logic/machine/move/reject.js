import { IN_STATE } from '../shared.js';
import { BOARD_SHAPE_REFUSALS } from '../shared.js';
import { AGENT_GRANT_REFUSALS } from '../shared.js';
import { VERDICT_REACHED_REFUSALS } from '../shared.js';
import { VERDICT_PATCH_REFUSALS } from '../shared.js';

/**
 * The `reject` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../../../io/machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'reject', from: ['submitted', 'verified'], to: 'open', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED',
    guards: ['coordinatorSaysAs', 'joined', 'itemExists', IN_STATE, 'gateReceipt', 'atSubmittedCommit', 'notMerged', 'verdictReviewRecorded', 'reviewTreeCurrent', 'companionWindow', 'notBuilder', 'routeAllows', 'policyAllows', 'requiredReviewFamily', 'familyAllows', 'reviewFree', 'criterionUnchanged', 'reasonCoded', 'noteGiven', 'causeWellFormed', 'clauseWellFormed'],
    alsoRefuses: [
      ...VERDICT_REACHED_REFUSALS,
      { code: 'AGENT_APPROVAL_REQUIRED', rule: 'the reviewed source satisfies the accepted spec approval policy', next: 'ask the coordinator to arrange the person confirmation or decline' },
      { code: 'UNKNOWN_SPEC', rule: 'the reviewed criterion cites governing approved rows', next: 'restore the governing spec rows or ask the coordinator to correct the item' },
      { code: 'SUBMISSION_PROOF', rule: 'recorded submission and known-main proof bind the reviewed source and trunk', next: 'retain native source-matched proof receipts and submit again before verification' },
      { code: 'SEAL_REVISION', rule: 'a reviewed plan that skips sealed packages names revisions this clone holds', next: 'fetch the submitted base and head, then verify again' },
      { code: 'SEAL_STALE', rule: 'every package the reviewed plan skipped keeps its current native seal receipt', next: 'run the skipped packages\' tests and submit again' },
      { code: 'TEST_SELECTION_SOURCE', rule: 'the immutable test-selection source is readable from Git', next: 'restore Git history and retry the selected test run' },
      { code: 'TEST_TIER_MANIFEST', rule: 'a tier-enabled project retains a valid generated test manifest', next: 'regenerate and commit the testing tier manifest' },
      { code: 'TEST_SELECTION_INCOMPLETE', rule: 'the supplied changed paths exactly match the committed Git diff', next: 'derive test selection from the complete committed diff' },
      { code: 'TEST_SELECTION_UNVERIFIED', rule: 'a green selected test run includes an observed test account', next: 'make the focused runner execute and report the selected tests' },

      { code: 'SUBMIT_HANDOFF_CHANGED', rule: 'the queued owner, captured source, companions and frozen bar still match', next: 'read the current claim and queued result; do not act for an old job' },
      { code: 'SUBMIT_HANDOFF_AUTHORITY', rule: 'a queued worker acts only for its exact native job and proved source', next: 'finish the captured job through its native worker; use the registered seat for other work' },
{ code: 'SOURCE_ADVANCE_STALE', rule: 'a verdict binds the effective head captured before its real check; a later automatic advance needs a fresh check', next: 'read the current item, bar, patches and main, then let the worker check the new exact composition' }, ...BOARD_SHAPE_REFUSALS, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }, ...AGENT_GRANT_REFUSALS, ...VERDICT_PATCH_REFUSALS, { code: 'VERDICT_ENVIRONMENT', rule: 'optional recorded verdict environment contains exact platform, architecture and Node version', next: 'run the frozen check with current Pullboard, then have an independent reviewer record a fresh verdict with its actual executor environment' }, { code: 'LAND_HEADER', rule: 'a displayed merge command carries a landing message that passes its own check', next: 'shout the coordinator the item id; landing writes the message, so the item itself needs no change' }, { code: 'ENGINE_VERSION', rule: 'a verdict that implies items replays only under engine 20 or later', next: 'upgrade Pullboard on every linked device before using --implies' }, { code: 'NOT_YOURS', rule: 'the automatic escalation is authorized as the coordinator or item holder', next: 'ask the coordinator to inspect the item and its route' }, { code: 'CLOSED', rule: 'the rejected item remains open or claimed when automatic escalation starts', next: 'pullboard show <id>, then ask the coordinator to inspect its current state' }],
    command: 'pullboard verify <id> reject --reason CODE --clause "failing requirement" --note "..."',
  },
];
