/** The pullboard export command, in its own module so an item adding another command never edits these lines. */
import {
  exportBoard,
  writeJsonChunks,
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
  const document = withBoard(ctx, (board) => exportBoard(board));
  // Written in pieces: a large board's events are more than one string can hold.
  if (!io.stdout?.write) io.say(JSON.stringify(document, null, 2));
  else { writeJsonChunks(document, text => io.stdout.write(text), 2); io.stdout.write('\n'); }
  return 0;
}
