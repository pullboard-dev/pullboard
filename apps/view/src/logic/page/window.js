/**
 * The slice of a fixed-height list to draw (#6676): the rows in the viewport plus a margin of rows on each side.
 * The page embeds this source, so it reads nothing from its module.
 *
 * @param {{ count: number, top: number, viewport: number, pitch: number, margin?: number }} input - count: rows in the
 *   list; top: the list's top edge from the viewport's top (negative once scrolled past it); viewport: the viewport's
 *   height; pitch: one row's height plus the gap below it; margin: extra rows drawn beyond each edge.
 * @returns {{ start: number, end: number }} Rows start up to, not including, end.
 */
export function rowWindow({ count, top, viewport, pitch, margin = 12 }) {
  const first = Math.floor(-top / pitch) - margin;
  const last = Math.ceil((viewport - top) / pitch) + margin;
  const start = Math.min(count, Math.max(0, first));
  return { start, end: Math.max(start, Math.min(count, last)) };
}
