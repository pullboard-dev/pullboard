import { IN_STATE } from '../shared.js';

/**
 * The `reland` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 * Landing returns an open landing-failure item to verified when its own accept and green gate still hold.
 *
 * @type {import('../../../io/machine.js').Move[]}
 */
export const MOVES = [
  { verb: 'reland', from: ['open'], to: 'verified', by: ['coordinator'], refuse: 'RELAND_NOT_ELIGIBLE',
    guards: ['coordinatorOnly', 'itemExists', IN_STATE, 'atSubmittedCommit', 'notBuilder', 'criterionUnchanged', 'proofNoted'],
    sets: ['item_verified_by'],
    command: 'landing, from the main checkout (no verb of its own)' },
];
