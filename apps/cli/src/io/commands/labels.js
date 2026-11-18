/** The pullboard labels command: each label's min, max, holders and unmet minimum, read-only [N2,B13]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { cappedLabelsOf } from '../../../../../packages/queue/index.js';
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
  const { labels, cappedItems } = withBoardRead(ctx, board => {
    const items = listItems(board);
    // Open items that carry a label at its max, pinned or not: next with next.labelBounds on leaves them unoffered [#9165].
    const capped = items.map(item => ({ item_id: item.item_id, labels: cappedLabelsOf(ctx.config.labels, items, item) })).filter(entry => entry.labels.length);
    return { labels: labelRows(ctx.config.labels, items), cappedItems: capped };
  });
  io.result?.({ labels, unmet: labels.filter(row => row.unmet).map(row => row.label), capped: cappedItems });
  if (!labels.length) io.say('no labels');
  for (const row of labels) {
    const holders = row.holders.length ? row.holders.join(', ') : 'none';
    io.say(`${row.label}  min ${row.min ?? '-'}  max ${row.max ?? '-'}  holders ${row.holders.length}: ${holders}${row.unmet ? '  UNMET MINIMUM' : ''}${row.capped ? '  AT MAXIMUM' : ''}`);
  }
  for (const entry of cappedItems) io.say(`#${entry.item_id} capped by ${entry.labels.join(', ')}`);
  return 0;
}
