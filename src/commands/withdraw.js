import * as store from '../board.js';
/** The pullboard withdraw command, in its own module so an item adding another command never edits these lines. */
import * as roadmapView from '../roadmap.js';
import {
  actOn,
  idArg,
  ordered,
} from '../cli.js';

/** Run `pullboard withdraw` and return its exit code. */
export function run(io, { first, second, rest }) {
  const act = (work) => actOn(io, work);
  return act((ctx, board, me) => roadmapView.withdrawWithMilestones(ctx, board, me, idArg(first),
  [second, ...rest].filter(Boolean).join(' '), ordered, store));
}
