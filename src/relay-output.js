/** Relay text output stays separate from CLI dispatch and encrypted transport [H15,H17]. */
import { formatSnapshotLimit } from './relay.js';
import { relayStorageLine } from './relay-storage.js';
import {
  describeMove,
  refusalLine,
} from './relay-outbox.js';

/** Preserve status's short relay summary, any pending-size finding and the authenticated account quota. */
export function briefLines(state) {
  const lines = [];
  if (state.excluded) lines.push(`relay excluded: ${state.exclusion.reason}${state.exclusion.at ? ' at ' + state.exclusion.at : ' (time unknown)'}; ${state.exclusion.next}`);
  if (state.linked) lines.push(`relay: sequence ${state.sequence}; ${state.behind} pending uploads${state.recovery?.pending ? `; recovery pending for sequence ${state.recovery.skip}; retry ${state.recovery.next}` : ''}`);
  if (state.oversizedSnapshot && !state.refusedCheckpoint) lines.push(formatSnapshotLimit(state.oversizedSnapshot));
  if (state.storage) lines.push(relayStorageLine(state.storage));
  lines.push(...outboxLines(state));
  return lines;
}

/** Name each move waiting in the relay outbox and each one refused when it replayed (#922). */
export function outboxLines(state) {
  const lines = [];
  if (state.outbox?.length) {
    lines.push(`relay outbox: ${state.outbox.length} ${state.outbox.length === 1 ? 'move waits' : 'moves wait'} for the relay, sent in this order when it answers:`);
    for (const move of state.outbox) lines.push(`  ${describeMove({ operation: move.operation, args: [move.item], actor: move.actor })} (made ${move.queuedAt}): pending`);
  }
  for (const refused of state.outboxRefusals ?? []) lines.push(refusalLine(refused));
  for (const { was, is } of state.outboxRenumbered ?? []) lines.push(`relay outbox: the item added here as #${was} while the relay was down is #${is} on the board`);
  return lines;
}

/** Preserve the named relay-status link and account lines, including recovery and deleted-copy guidance. */
export function detailLines(result, boardName) {
  const lines = [];
  if (result.excluded) lines.push(`relay excluded: ${result.exclusion.reason}${result.exclusion.at ? ' at ' + result.exclusion.at : ' (time unknown)'}; ${result.exclusion.next}`);
  lines.push(result.linked ? `${result.link}\nrelay: ${boardName} (board ${result.board}) is linked for GitHub ${result.login || `account ${result.account}`}; sequence ${result.sequence}; ${result.behind} pending uploads${result.recovery?.pending ? `; recovery pending for sequence ${result.recovery.skip}; retry ${result.recovery.next}` : ''}` : (result.notice || 'relay off; the local board is complete'));
  if (result.storage) lines.push(relayStorageLine(result.storage));
  return lines;
}
