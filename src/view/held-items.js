/**
 * Why an item is held, by the rule the Roadmap header counts it held: work not landed, accepted, in review or under a
 * live claim, whose own hold or whose lane's hold stops it. The item's own reason comes first. Null when it is not held,
 * so a list never says held where the header would not count it (#1256).
 *
 * @param {object} item - An item summary from the board state.
 * @param {{itemHolds?: object[], holds?: object[], laneHolds?: object[]}} source - The board the item belongs to.
 * @param {{state?: string}} [entry] - The item's roadmap entry, when it has one.
 * @returns {string|null}
 */
export function heldNote(item, source, entry) {
  if (!item || entry && ['landed', 'accepted'].includes(entry.state)) return null;
  const live = item.status === 'claimed' && Date.parse(item.claim?.until) > Date.now();
  if (!(item.status === 'open' || item.status === 'claimed' && !live)) return null;
  // Another board's summary may name its holds differently, or count them, so only a list is read.
  const own = (Array.isArray(source?.itemHolds) ? source.itemHolds : []).find(hold => hold.item === item.id);
  if (own) return 'held: ' + own.reason;
  const lane = ([source?.holds, source?.laneHolds].find(Array.isArray) || []).find(hold => hold.hold_lane === item.lane);
  return lane ? 'lane ' + item.lane + ' held: ' + lane.hold_reason : null;
}

/**
 * The held chip a list row shows, its reason on hover. A tap opens the row, whose detail says the same reason.
 *
 * @param {string} note - What heldNote returned.
 * @returns {string}
 */
export function heldChip(note) {
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  return '<span class="chip gate held" title="' + escape(note) + '">held</span>';
}
