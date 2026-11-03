import { atomic } from "./board-event-log.js";
import { logEvent } from "./board-event-log.js";
import { IN_STATE } from "../../../state/index.js";
import { Refused } from "../../../kernel/index.js";
import { moveItem } from "./board.js";
import { onlyCoordinator } from "./board.js";
import { createHash } from 'node:crypto';

/** Bind an audit-triggered withdrawal to the exact open frozen Main red observed by its writer. */
function requireExpectedMainRed(found, id, expected) {
  if (!expected) return;
  let frozen;
  try { frozen = JSON.parse(found.item_frozen ?? 'null'); } catch { frozen = null; }
  const matches = expected.status === 'open' && typeof expected.title === 'string' && expected.title.startsWith('Main red:')
    && typeof expected.check === 'string' && /^[a-f0-9]{64}$/u.test(expected.frozenDigest ?? '')
    && found.item_status === expected.status && found.item_title === expected.title
    && found.item_check === expected.check && found.item_frozen_digest === expected.frozenDigest
    && createHash('sha256').update(found.item_frozen ?? '').digest('hex') === expected.frozenDigest
    && frozen?.title === expected.title && frozen?.check === expected.check;
  if (!matches) throw new Refused('STALE_MAIN_RED', `item #${id} changed after its Main red audit`);
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
        [IN_STATE]: (found) => new Refused('CLOSED', `item #${id} is ${found.item_status}`),
      },
      before: found => requireExpectedMainRed(found, id, expected),
      set: () => ({ item_withdrawn_reason: reason.trim(), item_owner: null, item_lease_until: null }),
    });
    logEvent(board, agentId, 'withdraw', id, { reason: reason.trim() });
  });
}
