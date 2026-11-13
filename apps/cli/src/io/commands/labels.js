/** The pullboard labels command: each label's min, max, holders and unmet minimum, read-only [N2,B13]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { labelRows } from '../../../../../packages/queue/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { context } from '../entry.js';
import { withBoardRead } from '../entry.js';

/**
 * Run `pullboard labels [--json]` and return its exit code.
 * Why read-only: a label grants and denies nothing; the listing only shows where a declared minimum is not yet met.
 */
export function run(io, { first, second, rest, values }) {
  if (first || second || rest.length || Object.keys(values).some(key => key !== 'json')) {
    throw new Refused('USAGE', 'labels takes no arguments', 'pullboard labels [--json]');
  }
  const ctx = context(io);
  const labels = withBoardRead(ctx, board => labelRows(ctx.config.labels, listItems(board)));
  io.result?.({ labels, unmet: labels.filter(row => row.unmet).map(row => row.label) });
  if (!labels.length) io.say('no labels');
  for (const row of labels) {
    const holders = row.holders.length ? row.holders.join(', ') : 'none';
    io.say(`${row.label}  min ${row.min ?? '-'}  max ${row.max ?? '-'}  holders ${row.holders.length}: ${holders}${row.unmet ? '  UNMET MINIMUM' : ''}`);
  }
  return 0;
}
