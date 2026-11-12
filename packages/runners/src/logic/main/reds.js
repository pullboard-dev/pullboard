/** What a test run at a main commit tells the Main red ledger: which open items it closes, which reds it files [C7,#4635]. */

const LIVE = new Set(['open', 'claimed', 'submitted', 'verified']);

/** The live, unmerged Main red item that owns a test file, by its "Main red: <file>" title, or null. */
function ownerOf(items, file) {
  const title = `Main red: ${file}`;
  return items.find(item => (item.item_title === title || item.item_title?.startsWith(title + ' ')) && !item.item_merged_commit && LIVE.has(item.item_status)) ?? null;
}

/**
 * Decide the ledger updates one finished test run earns. A green run closes the open Main red item of each file it ran;
 * a red run files one for each failing file that has no live item, naming its failing cases. Only `qualified` files
 * count: those whose result is main's own, never a file an unlanded item's diff touches.
 * Why: the daily census was the only thing that closed or filed these, so a run that proved main's state changed nothing [C7,#4635].
 *
 * @param {{ items: object[], files: string[], green: boolean, failing?: Array<{file: string, name: string}>, qualified: Iterable<string>, main: string }} run
 * @returns {{ close: Array<{item: number, file: string}>, file: Array<{file: string, names: string[]}> }}
 */
export function mainRedUpdates({ items, files, green, failing = [], qualified, main }) {
  const ok = new Set(qualified);
  const close = [], file = [];
  if (!/^[a-f0-9]{40,64}$/u.test(main ?? '')) return { close, file };
  if (green) {
    for (const path of new Set(files)) {
      const owner = ok.has(path) ? ownerOf(items, path) : null;
      // Only an open item closes by itself; a claimed one has a builder, who finishes it.
      if (owner?.item_status === 'open') close.push({ item: owner.item_id, file: path });
    }
    return { close, file };
  }
  const byFile = new Map();
  for (const row of failing) if (row?.file && row.name) byFile.set(row.file, [...(byFile.get(row.file) ?? []), String(row.name)]);
  for (const [path, names] of byFile) if (ok.has(path) && !ownerOf(items, path)) file.push({ file: path, names: [...new Set(names)].slice(0, 20) });
  return { close, file };
}
