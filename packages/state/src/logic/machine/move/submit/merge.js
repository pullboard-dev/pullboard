import { IN_STATE } from '../../shared.js';
import { BOARD_SHAPE_REFUSALS } from '../../shared.js';
import { AGENT_GRANT_REFUSALS } from '../../shared.js';

/**
 * The `submit-merge` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../../../../io/machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'submit-merge', from: ['claimed'], to: 'verified', by: ['agent', 'coordinator'], refuse: 'NOT_YOURS',
    alsoRefuses: [...BOARD_SHAPE_REFUSALS, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }, ...AGENT_GRANT_REFUSALS],
    guards: ['joined', 'itemExists', IN_STATE, 'isHolder', 'correctionRefrozen', 'checkProvesSomething', 'barReady', 'clausesInspected', 'criterionUnchanged', 'treeClean', 'nothingUntracked', 'hasCommit', 'withinLane', 'trunkMergeClean', 'sourcePlaced', 'trunkInCandidate', 'noUnverifiedStack', 'doctrineHolds', 'gateConfigured', 'queuedItemLease', 'gateGreen', 'proofRecorded', 'treeStillDuringGate', 'submissionProofValid', 'childrenDone', 'headIsNew', 'mergeOnlyRecorded', 'atSubmittedCommit', 'notBuilder', 'proofNoted'],
    sets: ['item_built_by', 'item_commit', 'item_verified_by'], command: 'pullboard submit <id>',
    when: 'only an unchanged accepted bar and a proved trunk-only merge; no new reviewer verdict is created',
  },
];
