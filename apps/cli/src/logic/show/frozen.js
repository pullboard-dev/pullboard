/** The lines `pullboard show` prints for an item's frozen bar and its test authors, kept pure so a thin door can print them without the heavy readers [C7,#10766]. */

/**
 * The frozen-at-claim lines (digest, each row, each test hash with its person rulings) and the test author and reviewer family lines, in show's text.
 * The two groups come back named because another section sits between them.
 *
 * @param {{ item_frozen_digest?: string | null }} item the board's item row
 * @param {{ rows: { id: string, text: string, gate?: string }[], testHashes?: Record<string, string> } | null} frozen the item's parsed frozen bar, or null when none is frozen
 * @param {{ rulings: { path: string, factId: string, hash: string }[], authors: Record<string, { seat: string, family: string }>, reviewerFamilies: string[], testFiles: string[], agentName: (seat: string) => string, readable: (text: string) => string }} facts plain values the caller read
 * @returns {{ frozen: string[], authors: string[] }}
 */
export function frozenLines(item, frozen, { rulings, authors, reviewerFamilies, testFiles, agentName, readable }) {
  const lines = [];
  if (frozen) {
    lines.push(`frozen at claim (${item.item_frozen_digest.slice(0, 12)}):`);
    for (const row of frozen.rows) lines.push(`  ${row.id}: ${readable(row.text)}${row.gate ? `  | gate: ${row.gate}` : ''}`);
    for (const [path, hash] of Object.entries(frozen.testHashes ?? {})) {
      const ruled = rulings.filter(ruling => ruling.path === path);
      lines.push(`  test ${path}: sha256 ${hash}${ruled.length ? `; person ruling ${ruled.map(ruling => `${ruling.factId} accepts ${ruling.hash.slice(0, 12)}`).join(', ')}` : ''}`);
    }
  }
  const families = reviewerFamilies.join(', ') || 'none yet';
  const written = testFiles.map(path => {
    const author = authors[path];
    return `  test ${path}: author ${author ? `${agentName(author.seat)} [family ${author.family}]` : 'not recorded'}; reviewer family ${families}`;
  });
  return { frozen: lines, authors: written };
}
