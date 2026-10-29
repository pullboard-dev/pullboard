/** Lifecycle names and refusal lists that several move declarations share; a leaf, so declarations import it without a cycle [M1,C7]. */

/** The guard id that marks where a move checks the item's state; its code is the move's own. */
export const IN_STATE = 'inState';

/** Shared named item-grant refusals reachable through native dispatch. */
export const AGENT_GRANT_REFUSALS = [
  { code: 'AGENT_GRANT_EXPIRED', rule: 'an item mutation has a live claim or review grant', next: 'claim the intended item, or shout the coordinator if its claim is unavailable' },
  { code: 'AGENT_GRANT_ITEM', rule: 'an item mutation belongs to the current claim or review grant', next: 'finish or release the claim, then claim the intended item; use shout for coordination' },
  { code: 'AGENT_GRANT_LANE', rule: 'an item mutation stays inside the unclaimed seat lane', next: 'join a seat in the intended lane or ask its owner to make the item change' },
];

/** A restore may only lift guards whose installed complete shape has its valid stamp. */
export const PATCH_METADATA_REFUSAL = { code: 'ITEM_PATCH_FORMAT', rule: 'native patch metadata is readable', next: 'restore the native patch metadata from its ordered history' };
export const SOURCE_STATE_REFUSAL = { code: 'SOURCE_ADVANCE_STATE', rule: 'the ordered effective-head history is readable and bounded', next: 'restore the ordered source-advance history before using its effective head' };
export const BOARD_SHAPE_REFUSALS = [PATCH_METADATA_REFUSAL, SOURCE_STATE_REFUSAL, { code: 'SCHEMA_DRIFT', rule: 'the installed board guards and complete schema match their stored stamp', next: 'run pullboard inbox from the main checkout; if drift remains, preserve the board and ask the coordinator to inspect its schema' }];

export const VERDICT_PATCH_REFUSALS = [{ code: 'ITEM_PATCH', rule: 'native companion input composes safely against its source', next: 'replace the unsafe or conflicting patch with a source-bound correction' },
  { code: 'ITEM_PATCH_AUTHOR', rule: 'every patch has its registered source author', next: 'restore the native author before reviewing the patch' }];
