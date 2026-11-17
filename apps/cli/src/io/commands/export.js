/** The pullboard export command, in its own module so an item adding another command never edits these lines. */
import {
  exportBoard,
  itemFields,
  writeJsonChunks,
} from '../../../../../packages/store/index.js';
import { typedFieldsEnabled } from '../../../../../packages/config/index.js';
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
  const enabled = typedFieldsEnabled();
  const document = withBoard(ctx, (board) => {
    const exported = exportBoard(board);
    // With items.typedFields off the document is exactly what it was. On, `fields` maps each item id to its typed values;
    // it sits beside `tables`, not in the item rows, so an import still finds every table with exactly its columns [C7,#9352].
    if (!enabled) return exported;
    const fields = {};
    for (const row of exported.tables.item ?? []) {
      const own = itemFields(board, row.item_id, { enabled });
      if (own.length) fields[row.item_id] = own;
    }
    return Object.keys(fields).length ? { ...exported, fields } : exported;
  });
  // Written in pieces: a large board's events are more than one string can hold.
  if (!io.stdout?.write) io.say(JSON.stringify(document, null, 2));
  else { writeJsonChunks(document, text => io.stdout.write(text), 2); io.stdout.write('\n'); }
  return 0;
}
