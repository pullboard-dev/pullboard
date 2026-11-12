import { itemFolderIdentity } from './item/folder.js';
import { submitHandoffActor } from '../../../../packages/sandbox/index.js';
/** Caller identity keeps its synchronous full-store behavior for existing callers [C7,E18]. */
import * as store from '../../../../packages/store/index.js';
import { identifyCaller as readCaller } from './read.js';

/** Resolve the caller through the original full store, including coordinator housekeeping. */
export function identifyCaller(ctx, board, options) {
  const readers = { agentAt: (board, root) => submitHandoffActor(ctx, board) ?? store.agentAt(board, root) ?? itemFolderIdentity(board, root)?.agent, agentById: store.agentById,
    /** Registration remains a direct synchronous call on the real write path. */
    ensureCoordinator: (opened, path) => store.board_ensureCoordinator(opened, path) };
  return readCaller(ctx, board, options, readers);
}
