import { IN_STATE } from '../shared.js';
import { SOURCE_STATE_REFUSAL } from '../shared.js';
import { PATCH_METADATA_REFUSAL } from '../shared.js';

/**
 * The `reopen` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../../../io/machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'reopen', from: ['submitted', 'verified'], to: 'open', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED',
    guards: ['joined', 'itemExists', IN_STATE, 'reopenAuthority', 'noteGiven', 'causeWellFormed', 'notMerged', 'landingFailureRecorded', 'trunkConflicts', 'conflictAccepted'],
    alsoRefuses: [{ code: 'LINE_SETTING_RANGE', rule: 'automatic rejection routing reads validated board settings', next: 'restore the recorded board line setting before retrying' }, { code: 'BOARD_RETURNS_REJECTED', rule: 'the board returns rejected work automatically when opted in', next: 'run pullboard next to resume returned work' }, { code: 'PROOF_RUN_UNBOUND', rule: 'a source return retains exact native proof receipts and current quarantine event authority', next: 'run the item check with current Pullboard and use its stored native receipt; read pullboard show <id> for the proof chain' }, { code: 'SOURCE_ADVANCE_STALE', rule: 'an autonomous return binds the exact submitted source, current effective head, bar, patch set, verdict and episode', next: 'read the current item, bar, patches and main, then let the worker check the new exact composition' }, { code: 'SOURCE_ADVANCE_PROOF', rule: 'an autonomous return retains actual Git conflict paths or a native exact-source named red receipt; unknown infrastructure remains incomplete', next: 'run the exact frozen check and every affected test through the ordinary gate on the clean composition' }, SOURCE_STATE_REFUSAL, PATCH_METADATA_REFUSAL, { code: 'BAD_VERDICT_WITHDRAW', rule: 'the explicit withdrawal flag is boolean and is not combined with a conflict', next: 'use --withdraw-verdict with --note only, or report a conflict separately' }, { code: 'ENGINE_VERSION', rule: 'the withdrawal move is replayed by an engine defining its meaning', next: 'update Pullboard before withdrawing a verdict' }, { code: 'BAD_CONFIG', rule: 'the configured first-refusal duration fits a valid UTC deadline', next: 'set claim.reopenFirstRefusalMinutes to a non-negative whole number within the supported date range, or 0 to disable' }],
    sets: ['item_verdict', 'item_verified_by', 'item_owner', 'item_lease_until', 'item_review_by', 'item_review_until'],
    command: 'pullboard reopen <id> [--withdraw-verdict] --note "why" | --conflict <file> [--conflict <file>]',
  },
];
