/** The pullboard sweep command, in its own module so an item adding another command never edits these lines. */
import {
  actOn,
  sweepHere,
} from '../entry.js';

/** Run `pullboard sweep` and return its exit code. */
export function run(io, { values }) {
  const act = (work) => actOn(io, work);
  return act((ctx, board, me) => sweepHere(ctx, board, me, values));
}
