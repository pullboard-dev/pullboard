import { IN_STATE } from './machine-shared.js';
import { BOARD_SHAPE_REFUSALS } from './machine-shared.js';
import { AGENT_GRANT_REFUSALS } from './machine-shared.js';
import { VERDICT_PATCH_REFUSALS } from './machine-shared.js';

/**
 * The `reject` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; src/machine.js lists every move in order [M1,C7].
 *
 * @type {import('./machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'reject', from: ['submitted', 'verified'], to: 'open', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED',
    guards: ['coordinatorSaysAs', 'joined', 'itemExists', IN_STATE, 'atSubmittedCommit', 'notMerged', 'verdictReviewRecorded', 'reviewTreeCurrent', 'notBuilder', 'routeAllows', 'policyAllows', 'requiredReviewFamily', 'familyAllows', 'reviewFree', 'criterionUnchanged', 'reasonCoded', 'noteGiven', 'causeWellFormed', 'clauseWellFormed'],
    alsoRefuses: [{ code: 'SOURCE_ADVANCE_STALE', rule: 'a verdict binds the effective head captured before its real check; a later automatic advance needs a fresh check', next: 'read the current item, bar, patches and main, then let the worker check the new exact composition' }, ...BOARD_SHAPE_REFUSALS, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }, ...AGENT_GRANT_REFUSALS, ...VERDICT_PATCH_REFUSALS, { code: 'VERDICT_ENVIRONMENT', rule: 'optional recorded verdict environment contains exact platform, architecture and Node version', next: 'run the frozen check with current Pullboard, then have an independent reviewer record a fresh verdict with its actual executor environment' }, { code: 'LAND_HEADER', rule: 'a displayed merge command carries a landing message that passes its own check', next: 'shout the coordinator the item id; landing writes the message, so the item itself needs no change' }, { code: 'ENGINE_VERSION', rule: 'a verdict that implies items replays only under engine 20 or later', next: 'upgrade Pullboard on every linked device before using --implies' }, { code: 'NOT_YOURS', rule: 'the automatic escalation is authorized as the coordinator or item holder', next: 'ask the coordinator to inspect the item and its route' }, { code: 'CLOSED', rule: 'the rejected item remains open or claimed when automatic escalation starts', next: 'pullboard show <id>, then ask the coordinator to inspect its current state' }],
    command: 'pullboard verify <id> reject --reason CODE --clause "failing requirement" --note "..."',
  },
];
