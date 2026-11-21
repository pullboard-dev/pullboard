/** `pullboard stats tests`: test files that failed the gates of many unrelated items, read-only over the board's test results [C7]. */
import { gateFailRows } from '../../../../../../packages/store/index.js';
import { costlyTests } from '../../../../../../packages/stats/index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';
import { sinceCutoff } from '../../trace.js';
import { withBoard } from '../../entry.js';

/** The window and fewest unrelated items used when a flag is absent. */
const DEFAULT_SINCE = '24h';
const DEFAULT_MIN_ITEMS = 5;

/** The costly test files for a window, read from the board's gate fail rows. */
export function costlyTestFiles(ctx, { since = DEFAULT_SINCE, minItems = DEFAULT_MIN_ITEMS } = {}) {
  const cutoff = sinceCutoff(since, ctx.clock.now().getTime());
  if (cutoff === null) throw new Refused('USAGE', '--since takes <number><s|m|h|d>, for example pullboard stats tests --since 24h');
  const rows = withBoard(ctx, board => gateFailRows(board.db, { since: cutoff }));
  return costlyTests(rows, { minItems, since: cutoff });
}

/** The one-line summary plain `pullboard stats` prints: `costly tests: <n> files in 24h, top <file> <items> items <minutes> runner-min`. */
export function costlyTestsSummary(ctx) {
  const files = costlyTestFiles(ctx);
  const top = files[0];
  return `costly tests: ${files.length} files in ${DEFAULT_SINCE}${top ? `, top ${top.file} ${top.items.length} items ${top.runnerMinutes} runner-min` : ''}`;
}

/** Run `pullboard stats tests [--since 24h] [--min-items 5] [--json]` and return its exit code; it writes nothing to the board. */
export function runCostlyTests(io, ctx, { second, rest, values }) {
  if (second !== undefined || rest?.length || values.window !== undefined || values.compare) throw new Refused('USAGE', 'name test files that failed many unrelated gates with pullboard stats tests [--since 24h] [--min-items 5] [--json]');
  const since = values.since ?? DEFAULT_SINCE;
  const minItems = values['min-items'] === undefined ? DEFAULT_MIN_ITEMS : Number(values['min-items']);
  if (!Number.isInteger(minItems) || minItems < 1) throw new Refused('USAGE', '--min-items takes a whole number of 1 or more, for example pullboard stats tests --min-items 5');
  const files = costlyTestFiles(ctx, { since, minItems });
  io.result?.({ version: 1, since, minItems, files });
  if (!files.length) {
    io.say(`no test file failed the gates of ${minItems} or more unrelated items in ${since}`);
    return 0;
  }
  io.say('file | items | runs | runner-min');
  for (const row of files) io.say(`${row.file} | ${row.items.map(id => `#${id}`).join(' ')} | ${row.runs} | ${row.runnerMinutes}`);
  return 0;
}
