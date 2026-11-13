import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { IN_STATE } from "../../../../state/index.js";
import { Refused } from "../../../../kernel/index.js";
import { moveItem } from "../board.js";
import { onlyCoordinator } from "../board.js";
import { endWithdrawnHandoff } from "../submit/handoff/retry.js";
import { endReviewLease } from "./review/lease.js";
import { createHash } from 'node:crypto';

/** Bind an audit-triggered withdrawal to the exact open frozen Main red observed by its writer. */
function expectedMainRedProblem(found, id, expected) {
  if (expected === null || expected === undefined) return null;
  let frozen;
  try { frozen = JSON.parse(found.item_frozen ?? 'null'); } catch { frozen = null; }
  const matches = expected.status === 'open' && typeof expected.title === 'string' && expected.title.startsWith('Main red:')
    && typeof expected.check === 'string' && /^[a-f0-9]{64}$/u.test(expected.frozenDigest ?? '')
    && typeof expected.head === 'string' && /^[a-f0-9]{40,64}$/u.test(expected.head)
    && found.item_status === expected.status && found.item_title === expected.title
    && found.item_check === expected.check && found.item_frozen_digest === expected.frozenDigest
    && createHash('sha256').update(found.item_frozen ?? '').digest('hex') === expected.frozenDigest
    && frozen?.title === expected.title && frozen?.check === expected.check;
  return matches ? null : new Refused('STALE_MAIN_RED', `item #${id} changed after its Main red audit`);
}

/** Keep the required cause fact in the withdrawal transaction, with one replay-stable identity. */
function recordMainRedFix(board, id, agentId, expected) {
  const hash = createHash('sha256').update(JSON.stringify(['main-red-fixed', id, expected.frozenDigest, expected.head])).digest('hex');
  const factId = [hash.slice(0, 8), hash.slice(8, 12), '5' + hash.slice(13, 16), '8' + hash.slice(17, 20), hash.slice(20, 32)].join('-');
  logEvent(board, agentId, 'fact', id, { id: factId, kind: 'measurement', ref: null, supersedes: null,
    text: `Fixed on main by ${expected.head}; every file named in the frozen check passed in the current-tip audit.` });
}

/**
 * Withdraw an item nobody should build: a duplicate, or no longer wanted.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, reason: string }} why
 */
export function withdraw(board, id, { agentId, reason, expected = null }) {
  atomic(board, () => {
    moveItem(board, id, 'withdraw', {
      checks: {
        joined: null,
        coordinatorOnly: () => onlyCoordinator(agentId, 'withdraws items'),
        noteGiven: () => (reason.trim() ? null : new Refused('NOTE_REQUIRED', 'say why it is withdrawn')),
        mainRedUnchanged: found => expectedMainRedProblem(found, id, expected),
        [IN_STATE]: (found) => new Refused('CLOSED', `item #${id} is ${found.item_status}`),
      },
      set: () => ({ item_withdrawn_reason: reason.trim(), item_owner: null, item_lease_until: null }),
    });
    endWithdrawnHandoff(board, id);
    endReviewLease(board, id);
    logEvent(board, agentId, 'withdraw', id, { reason: reason.trim() });
    if (expected) recordMainRedFix(board, id, agentId, expected);
  });
}
