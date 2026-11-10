import { IN_STATE } from '../shared.js';

/**
 * The `refreeze` and `refreeze` lifecycle moves, declared in their own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../../../io/machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'refreeze', from: ['open', 'claimed', 'submitted', 'verified'], to: 'open', by: ['coordinator'], refuse: 'CLOSED',
    guards: ['joined', 'coordinatorOnly', 'itemExists', IN_STATE, 'specRefreezeAllowed', 'barReady', 'rowsInForce'],
    when: 'there is no live claim awaiting a coordinator correction',
    sets: ['item_frozen_digest'], command: 'pullboard refreeze <id>',
  },
  {
    verb: 'refreeze', from: ['claimed'], to: 'claimed', by: ['agent', 'coordinator'], refuse: 'CLOSED',
    guards: ['joined', 'itemExists', 'holderOrCoordinator', IN_STATE, 'specRefreezeAllowed', 'barReady', 'rowsInForce'],
    when: 'a live claim has a pending coordinator correction or a validated cited-spec correction',
    sets: ['item_frozen', 'item_frozen_digest'], command: 'pullboard refreeze <id>',
  },
];
