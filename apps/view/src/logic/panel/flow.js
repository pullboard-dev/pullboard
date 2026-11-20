/** The Flow panel model: one row per unlanded item and one entry per idle seat, read from the flow document [N26,C7]. */

/**
 * Turn the version 1 flow document into the rows the Flow panel draws.
 * Why pure and apart from render.js: the rows are checked without markup, and slice 2 draws them.
 *
 * @param {{ items?: any[], idle?: any[] }} doc - What flowWhy returns (packages/health/src/logic/flow.js).
 * @returns {{ rows: { id: number, cause: string }[], idle: { seat: string, reason: string }[] }} One row per item, one entry per idle seat.
 */
export function flowPanelModel(doc) {
  const rows = (doc?.items ?? []).map(item => ({ ...item, id: item.id, cause: item.cause }));
  const idle = (doc?.idle ?? []).map(seat => ({ ...seat, seat: seat.seat, reason: seat.reason }));
  return { rows, idle };
}
