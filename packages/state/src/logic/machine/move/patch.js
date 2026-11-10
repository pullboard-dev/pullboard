import { IN_STATE } from '../shared.js';

/**
 * The `patch-claimed` and `patch` lifecycle moves, declared in their own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../../../io/machine.js').Move[]}
 */
export const MOVES = [
  { verb: 'patch-objected', from: ['claimed', 'submitted'], to: 'open', by: ['agent'], refuse: 'ITEM_PATCH_WINDOW',
    guards: ['joined', 'itemExists', IN_STATE, 'patchObjection'],
    sets: ['item_owner', 'item_lease_until', 'item_verdict', 'item_verified_by', 'item_review_by', 'item_review_until'],
    command: 'pullboard patch object <id> <key> --note "why"' },
  { verb: 'patch-claimed', from: ['claimed'], to: 'claimed', by: ['coordinator'], refuse: 'ITEM_PATCH_STATE',
    guards: ['joined', 'itemExists', IN_STATE, 'coordinatorOnly', 'notMerged'],
    sets: [], command: 'pullboard patch attach|remove <id>' },
  { verb: 'patch', from: ['submitted', 'verified'], to: 'submitted', by: ['coordinator'], refuse: 'ITEM_PATCH_STATE',
    guards: ['joined', 'itemExists', IN_STATE, 'coordinatorOnly', 'notMerged'],
    sets: ['item_built_by', 'item_frozen_digest', 'item_verdict', 'item_verified_by', 'item_review_by', 'item_review_until'], command: 'pullboard patch attach|remove <id>' },
];
