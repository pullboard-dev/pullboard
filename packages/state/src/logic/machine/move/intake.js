import { IN_STATE } from '../shared.js';

/**
 * The `intake` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../../../io/machine.js').Move[]}
 */
export const MOVES = [
  { verb: 'intake', from: ['open'], to: 'submitted', by: ['agent', 'coordinator'], refuse: 'NOT_CLAIMABLE',
    guards: ['joined', 'itemExists', IN_STATE, 'outsideSubmission'], sets: ['item_built_by', 'item_commit', 'item_frozen_digest'], command: 'pullboard intake <PR> --criterion \"...\" --check \"...\"' },
];
