import { submitHandoffActor } from './submit-handoff-origin.js';
/** Caller identity keeps its synchronous full-store behavior for existing callers [C7,E18]. */
import * as store from './board.js';
import { identifyCaller as readCaller } from './cli-read-context.js';

/** Resolve the caller through the original full store, including coordinator housekeeping. */
export function identifyCaller(ctx, board, options) {
  const readers = { agentAt: (board, root) => submitHandoffActor(ctx, board) ?? store.agentAt(board, root), agentById: store.agentById,
    /** Registration remains a direct synchronous call on the real write path. */
    ensureCoordinator: (opened, path) => store.ensureCoordinator(opened, path) };
  return readCaller(ctx, board, options, readers);
}
