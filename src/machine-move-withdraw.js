import { IN_STATE } from './machine-shared.js';

/**
 * The `withdraw` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; src/machine.js lists every move in order [M1,C7].
 *
 * @type {import('./machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'withdraw', from: ['open', 'claimed', 'submitted'], to: 'withdrawn', by: ['coordinator'], refuse: 'CLOSED',
    guards: ['joined', 'coordinatorOnly', 'noteGiven', 'itemExists', IN_STATE],
    sets: ['item_withdrawn_reason'], command: 'pullboard withdraw <id> <reason>',
  },
];
