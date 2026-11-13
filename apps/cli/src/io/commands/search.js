/** The pullboard search command: the board items most like some text, best first, read-only [C7]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { searchItemRows } from '../../../../../packages/search/index.js';
import { searchSidecarPath } from '../../../../../packages/search/index.js';
import { context } from '../entry.js';
import { withBoardRead } from '../entry.js';

/** How many matches the command prints. */
const TOP = 5;

/**
 * Run `pullboard search <text>` and return its exit code.
 * Why read-only: finding a duplicate must never change the board; only the derived sidecar file may be (re)built.
 */
export function run(io, { first, second, rest }) {
  const text = [first, second, ...(rest ?? [])].filter(Boolean).join(' ').trim();
  if (!text) throw new Refused('NO_QUERY', 'search needs some text to look for', 'pullboard search "the words of the item you are looking for"');
  const ctx = context(io);
  const sidecar = searchSidecarPath(ctx.info.root, ctx.info.commonDir);
  const matches = withBoardRead(ctx, board => searchItemRows(board, text, { sidecar, limit: TOP }));
  io.result?.({ query: text, matches });
  if (!matches.length) io.say('no matching items');
  for (const match of matches) io.say(`${match.score.toFixed(3)}  #${match.id}  ${match.state}  ${match.title}`);
  return 0;
}
