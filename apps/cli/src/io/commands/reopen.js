/** The pullboard reopen command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import {
  COORDINATOR,
} from '../../../../../packages/config/index.js';
import {
  reopenConflict,
  requireTrunkConflict,
  reopenedLine,
} from '../../../../../packages/merge/index.js';
import {
  trunkMerge,
} from '../../../../../packages/sandbox/index.js';
import { legacyConflictNote } from '../../../../../packages/items/index.js';
import {
  actOn,
  idArg,
  ordered,
  textArg,
} from '../entry.js';

/** Run `pullboard reopen` and return its exit code. */
export async function run(io, { first, values }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const note = textArg(io, values, 'note') ?? '';
  const historical = values.conflict === undefined && !values['withdraw-verdict'] ? legacyConflictNote(note) : null;
  let inferred = null;
  if (historical && me.id === COORDINATOR) {
    const item = store.getItem(board, idArg(first));
    if (['verified', 'submitted'].includes(item.item_status) && item.item_commit && !item.item_merged_commit) {
      inferred = requireTrunkConflict(commit => trunkMerge(ctx.info.root, commit, undefined, { raw: true }), item.item_commit, historical.files);
    }
  }
  const result = await ordered(ctx, board, 'reopen', [idArg(first), { agentId: me.id, note,
    ...(inferred ? { conflict: inferred } : {}),
    ...(values['withdraw-verdict'] === undefined ? {} : { withdrawVerdict: values['withdraw-verdict'] }),
    ...(values.cause !== undefined ? { cause: values.cause } : {}),
    ...(values.conflict === undefined ? {} : { conflict: reopenConflict({ item: store.getItem(board, idArg(first)), coordinator: me.id === COORDINATOR, values: values.conflict, trunkMerge: (commit) => trunkMerge(ctx.info.root, commit, undefined, { raw: true }) }) }) }]);
  io.result?.(result);
  io.say(reopenedLine(first, result));
  return 0;
});
}
