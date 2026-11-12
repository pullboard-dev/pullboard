import { IN_STATE } from '../shared.js';
import { SOURCE_STATE_REFUSAL } from '../shared.js';

/**
 * The `reserve` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../../../io/machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'reserve', from: ['submitted'], to: 'submitted', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED',
    alsoRefuses: [SOURCE_STATE_REFUSAL, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }],
    guards: ['coordinatorSaysAs', 'joined', 'roadmapReadable', 'itemExists', IN_STATE, 'gateReceipt', 'reviewCooldownElapsed', 'companionWindow', 'notBuilder', 'routeAllows', 'policyAllows', 'requiredReviewFamily', 'familyAllows', 'reviewFree'],
    sets: ['item_review_by', 'item_review_until'], command: 'pullboard next --verify',
  },
];
