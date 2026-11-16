/**
 * The Dashboard hero's last-four-hour counts, read on the server from the board's own events [N26].
 * Why: on a long board the browser may never finish reading the whole event log, and the hero then had
 * nothing to count. Each kind is read newest first through the kind index and stops at the window's edge,
 * so the cost follows the last four hours, never the length of the log.
 *
 * @param {any} board - An open board; only its event table is read.
 * @param {Map<number, { item_merged_commit?: string | null }>} items - Every item on the board, by id.
 * @param {number} now - The snapshot clock in milliseconds.
 * @returns {{ landed: number, passed: number, accepted: number, sentBack: number, shouts: number, since: number, until: number }}
 */
export function dashboardRecent(board, items, now) {
  const since = now - 4 * 3_600_000;
  const newest = board.db.prepare('SELECT item_id, event_at, event_detail FROM event WHERE event_kind = ? ORDER BY event_id DESC');
  /** Every event of one kind inside (since, now], newest first. */
  const within = kind => {
    const rows = [];
    for (const row of newest.iterate(kind)) {
      const at = Date.parse(row.event_at);
      if (!Number.isFinite(at)) continue;
      if (at <= since) break;
      if (at <= now) rows.push({ ...row, at });
    }
    return rows;
  };
  /** Parse a native event payload; a malformed one counts as nothing. */
  const detail = row => { try { return JSON.parse(row.event_detail || '{}'); } catch { return {}; } };
  // A landing counts at the first recording of the item's current merge, as the Dashboard model counts it.
  const firstMerge = board.db.prepare("SELECT event_at, event_detail FROM event WHERE item_id = ? AND event_kind = 'merged' ORDER BY event_id");
  const landed = new Set();
  for (const row of within('merged')) {
    const commit = items.get(row.item_id)?.item_merged_commit;
    if (!commit || landed.has(row.item_id) || detail(row).commit !== commit) continue;
    const first = firstMerge.all(row.item_id).find(entry => detail(entry).commit === commit);
    if (first && Date.parse(first.event_at) > since) landed.add(row.item_id);
  }
  return {
    landed: landed.size,
    passed: new Set([...within('accept').map(row => row.item_id), ...landed]).size,
    accepted: within('accept').length,
    sentBack: within('reject').length + within('reopen').length,
    shouts: within('shout').filter(row => detail(row).to === 'person').length,
    since, until: now,
  };
}
