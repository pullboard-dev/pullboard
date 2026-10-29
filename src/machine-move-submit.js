import { IN_STATE } from './machine-shared.js';
import { BOARD_SHAPE_REFUSALS } from './machine-shared.js';
import { AGENT_GRANT_REFUSALS } from './machine-shared.js';

/**
 * The `submit` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; src/machine.js lists every move in order [M1,C7].
 *
 * @type {import('./machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'submit', from: ['claimed'], to: 'submitted', by: ['agent', 'coordinator'], refuse: 'NOT_YOURS',
    alsoRefuses: [...BOARD_SHAPE_REFUSALS, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }, ...AGENT_GRANT_REFUSALS, { code: 'LINE_SETTING_RANGE', rule: 'the recorded board line setting has a valid registry value', next: 'restore the recorded board line setting from its ordered event history, then retry submit' },
      { code: 'UNDECLARED_BUILDER_FAMILY', rule: 'a strict item is submitted by a builder with a declared vendor family', next: 'rejoin with: pullboard join <lane> --family <vendor> --model "<model name>", then submit again' },
      { code: 'BAD_REVIEW_POLICY', rule: 'the native review policy of the item is readable', next: 'restore the native review policy before reviewing this item' },
      { code: 'MERGE_ONLY_PROOF', rule: 'a requested carry matches the recorded conflict return, acceptance and exact gated source', next: 'submit normally for outside review' },
      { code: 'SELF_VERIFY', rule: 'the retained original verifier did not author the merge resubmission', next: 'submit the changed source for outside review' },
      { code: 'SELF_SESSION_VERIFY', rule: 'the retained verifier shares no author parent with the resubmitting builder', next: 'submit for another parent session to review' },
      { code: 'PROOF_REQUIRED', rule: 'a carried acceptance records the actual resolution diff', next: 'submit with the current CLI or get an outside review' }],
    guards: ['joined', 'itemExists', IN_STATE, 'isHolder', 'correctionRefrozen', 'checkProvesSomething', 'barReady', 'criterionUnchanged', 'treeClean', 'nothingUntracked', 'hasCommit', 'withinLane', 'trunkMergeClean', 'sourcePlaced', 'trunkInCandidate', 'noUnverifiedStack', 'infraExplained', 'doctrineHolds', 'gateConfigured', 'queuedItemLease', 'gateGreen', 'proofRecorded', 'treeStillDuringGate', 'submissionProofValid', 'childrenDone', 'headIsNew'],
    sets: ['item_built_by', 'item_commit'], command: 'pullboard submit <id>',
  },
];
