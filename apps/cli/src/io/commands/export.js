/** The pullboard export command, in its own module so an item adding another command never edits these lines. */
import {
  exportBoard,
} from '../../../../../packages/store/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  context,
  withBoard,
} from '../entry.js';

/** Run `pullboard export` and return its exit code. */
export function run(io, { first }) {
  if (first) throw new Refused('USAGE', 'pullboard export takes no arguments');
  const ctx = context(io);
  io.say(JSON.stringify(withBoard(ctx, (board) => exportBoard(board)), null, 2));
  return 0;
}
