/** Light door: the outbox's status fields and conflict notices, without the relay, replay and checkpoint closure [C7]. */
export { takeConflictNotices } from './src/io/relay/conflicts.js';
export { withFileLock } from './src/io/relay/guard.js';

/** The queued moves and replay refusals pullboard status shows, when there are any. */
export function outboxFields(state) {
  return { ...(state?.outbox?.moves?.length ? { outbox: structuredClone(state.outbox.moves) } : {}),
    ...(state?.outboxRefusals?.length ? { outboxRefusals: structuredClone(state.outboxRefusals) } : {}),
    ...(state?.outboxRenumbered?.length ? { outboxRenumbered: structuredClone(state.outboxRenumbered) } : {}) };
}
