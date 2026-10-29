import { IN_STATE } from './machine-shared.js';
import { SOURCE_STATE_REFUSAL } from './machine-shared.js';
import { PATCH_METADATA_REFUSAL } from './machine-shared.js';

/**
 * The `claim` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; src/machine.js lists every move in order [M1,C7].
 *
 * @type {import('./machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'claim', from: ['open', 'claimed'], to: 'claimed', by: ['agent', 'coordinator'], refuse: 'NOT_CLAIMABLE',
    alsoRefuses: [SOURCE_STATE_REFUSAL, PATCH_METADATA_REFUSAL, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' },
      { code: 'ITEM_LEASE_LOST', rule: 'a submit admission renews the same still-live build claim', next: 'claim the item before starting a new submit' },
      { code: 'ENGINE_VERSION', rule: 'adopting a coordinator correction replays only under an engine defining atomic correction adoption', next: 'upgrade Pullboard on every linked device before adopting a coordinator correction' }],
    guards: ['joined', 'itemExists', IN_STATE, 'checkProvesSomething', 'barReady', 'itemNotHeld', 'inLane', 'routeAllows', 'dependenciesVerified', 'notHeldByAnother', 'builderFirstRefusal', 'correctionRefrozen', 'laneOpen', 'lineCapacity', 'oneLiveClaim', 'rowsInForce'],
    sets: ['item_owner', 'item_lease_until', 'item_frozen_digest'], command: 'pullboard claim <id>',
  },
];
