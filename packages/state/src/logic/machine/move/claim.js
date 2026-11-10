import { IN_STATE } from '../shared.js';
import { SOURCE_STATE_REFUSAL } from '../shared.js';
import { PATCH_METADATA_REFUSAL } from '../shared.js';

/**
 * The `claim` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../../../io/machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'claim', from: ['open', 'claimed'], to: 'claimed', by: ['agent', 'coordinator'], refuse: 'NOT_CLAIMABLE',
    alsoRefuses: [SOURCE_STATE_REFUSAL, PATCH_METADATA_REFUSAL, { code: 'RELAY_MOVE', rule: 'the CLI seals the fallback rework-routing fact identity into the claim before board mutation', next: 'retry the claim through the current Pullboard CLI so it can seal the fact identity' }, { code: 'EXIT_CONTINUATION', rule: 'an exit handoff retains a known native original session and honest declared family', next: 'read the item summary, then continue from a fresh native session of its reserved model family' }, { code: 'EXIT_USAGE', rule: 'an enabled exit policy carries a fresh native immutable claim identity', next: "restore the original private claim anchor; unreadable or reset native counters must remain unknown" }, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' },
      { code: 'ITEM_LEASE_LOST', rule: 'a submit admission renews the same still-live build claim', next: 'claim the item before starting a new submit' },
      { code: 'ENGINE_VERSION', rule: 'adopting a coordinator correction replays only under an engine defining atomic correction adoption', next: 'upgrade Pullboard on every linked device before adopting a coordinator correction' }],
    guards: ['joined', 'itemExists', IN_STATE, 'checkProvesSomething', 'barReady', 'itemNotHeld', 'inLane', 'routeAllows', 'buildScopeFits', 'dependenciesVerified', 'notHeldByAnother', 'builderFirstRefusal', 'correctionRefrozen', 'laneOpen', 'lineCapacity', 'oneLiveClaim', 'rowsInForce'],
    sets: ['item_owner', 'item_lease_until', 'item_frozen_digest'], command: 'pullboard claim <id>',
  },
];
