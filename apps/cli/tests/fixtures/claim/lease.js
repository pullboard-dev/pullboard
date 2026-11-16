/** A real SQLite board with two builder seats, for file-lease claims [C7,#8521]. */
// fixture-subject: addItem
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';

export const HOUR = 60 * 60 * 1000;
const FREEZE = item => ({ text: item.item_title, digest: `digest:${item.item_title}` });

/** One board, a coordinator, two strong builders and helpers to add items and claim them through the board's write path. */
export function leaseBoard(t, lease) {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/coordinator' });
  const first = store.register(board, { lane: 'core', path: '/first', route: 'strong' });
  const second = store.register(board, { lane: 'core', path: '/second', route: 'strong' });
  board.fileLease = lease;
  /** Add an open item whose brief names these files and whose bar is the given text. */
  const add = (title, files, criterion) => store.addItem(board, { by: 'coordinator', lane: 'core', title, route: 'strong',
    brief: `Files: ${files.join(', ')}`, ...(criterion ? { criterion } : {}) });
  /** Claim through writeBoardCommand, the path every CLI claim takes. */
  const claim = (id, agentId) => store.writeBoardCommand(board, 'claim', [id, { agentId, lane: 'core', leaseMs: HOUR, freeze: FREEZE }], agentId);
  /** Submit a claimed item whose commit changed these files, straight through the board's submit path [#8522]. */
  const submit = (id, agentId, files) => store.submit(board, id, { agentId, commit: 'a'.repeat(40), tree: 'b'.repeat(40), files,
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'fixture setup, not an execution claim' } });
  return { board, first, second, add, claim, submit };
}
