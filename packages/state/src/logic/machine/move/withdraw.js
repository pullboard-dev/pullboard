import { IN_STATE } from '../shared.js';

/**
 * The `withdraw` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../../../io/machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'withdraw', from: ['open', 'claimed', 'submitted', 'verified'], to: 'withdrawn', by: ['coordinator'], refuse: 'CLOSED',
    // Withdraw ends the item's gate jobs, whose step writer refuses a missing job or an unnamed step [C7,M1].
    alsoRefuses: [{ code: 'JOB_MISSING', rule: 'the code path this move reaches raises it only when its own precondition fails', next: 'read the message, repair the cause it names, then run the command again' }, { code: 'JOB_STEP_NAME', rule: 'the code path this move reaches raises it only when its own precondition fails', next: 'read the message, repair the cause it names, then run the command again' }],
    guards: ['joined', 'coordinatorOnly', 'noteGiven', 'itemExists', 'mainRedUnchanged', IN_STATE],
    sets: ['item_withdrawn_reason'], command: 'pullboard withdraw <id> <reason>',
  },
];
