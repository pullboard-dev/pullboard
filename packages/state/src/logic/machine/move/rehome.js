import { IN_STATE } from '../shared.js';

/**
 * The `rehomeImport` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../../../io/machine.js').Move[]}
 */
export const MOVES = [
  { verb: 'rehomeImport', from: ['open'], to: 'verified', by: ['agent'], refuse: 'REHOME_VERDICT',
    guards: ['joined', 'itemExists', IN_STATE, 'sourceAcceptance', 'atSubmittedCommit', 'notBuilder', 'criterionUnchanged', 'proofNoted'],
    sets: ['item_verified_by', 'item_commit'],
    command: 'pullboard move <item reference> --to <handle>' },
];
