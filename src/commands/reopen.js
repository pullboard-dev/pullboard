/** The pullboard reopen command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import {
  COORDINATOR,
} from '../config.js';
import {
  reopenConflict,
  requireTrunkConflict,
  reopenedLine,
} from '../trunk-conflict.js';
import {
  trunkMerge,
} from '../trusted-policy.js';
import { legacyConflictNote } from '../reopen-cause.js';
import {
  actOn,
  idArg,
  ordered,
  textArg,
} from '../cli.js';

/** Run `pullboard reopen` and return its exit code. */
export async function run(io, { first, values }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const note = textArg(io, values, 'note') ?? '';
  const historical = values.conflict === undefined && !values['withdraw-verdict'] ? legacyConflictNote(note) : null;
  const inferred = historical && me.id === COORDINATOR
    ? requireTrunkConflict(commit => trunkMerge(ctx.info.root, commit), store.getItem(board, idArg(first)).item_commit, historical.files) : null;
  const result = await ordered(ctx, board, 'reopen', [idArg(first), { agentId: me.id, note,
    ...(inferred ? { conflict: inferred } : {}),
    ...(values['withdraw-verdict'] === undefined ? {} : { withdrawVerdict: values['withdraw-verdict'] }),
    ...(values.cause !== undefined ? { cause: values.cause } : {}),
    ...(values.conflict === undefined ? {} : { conflict: reopenConflict({ item: store.getItem(board, idArg(first)), coordinator: me.id === COORDINATOR, values: values.conflict, trunkMerge: (commit) => trunkMerge(ctx.info.root, commit) }) }) }]);
  io.result?.(result);
  io.say(reopenedLine(first, result));
  return 0;
});
}
