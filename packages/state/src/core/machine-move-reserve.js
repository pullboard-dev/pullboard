import { IN_STATE } from './machine-shared.js';
import { SOURCE_STATE_REFUSAL } from './machine-shared.js';

/**
 * The `reserve` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; src/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../shell/machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'reserve', from: ['submitted'], to: 'submitted', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED',
    alsoRefuses: [
      { code: 'NO_POLICY', rule: 'a reserve reads the available committed coordinator policy', next: 'restore and commit pullboard.json, then run the command again' },
      { code: 'ITEM_BUILD_BUDGET', rule: 'a reserve that hands the next build offers only work within the board build budget', next: 'split the item by clause into items within the build budget' },
      { code: 'BAD_BUILD_BUDGET', rule: 'the board build budget is a positive number of minutes', next: 'restore a positive itemBuildBudgetMinutes setting, then retry' },
      SOURCE_STATE_REFUSAL, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }],
    guards: ['coordinatorSaysAs', 'joined', 'roadmapReadable', 'itemExists', IN_STATE, 'reviewCooldownElapsed', 'notBuilder', 'routeAllows', 'policyAllows', 'requiredReviewFamily', 'familyAllows', 'reviewFree'],
    sets: ['item_review_by', 'item_review_until'], command: 'pullboard next --verify',
  },
];
