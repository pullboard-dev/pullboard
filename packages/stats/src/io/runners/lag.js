/** Read the main commits that landed in a window, read-only, for the main check lag [C7]. */

/**
 * The `main-moved` events in a window: the commit now on main and when it landed.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{from: number, until: number}} window - epoch ms
 * @returns {{sha: string, at: number}[]}
 */
export function readMainLandings(db, { from, until }) {
  const rows = db.prepare("SELECT event_at, event_detail FROM event WHERE event_kind = 'main-moved' AND event_at >= ? AND event_at < ? ORDER BY event_id")
    .all(new Date(from).toISOString(), new Date(until).toISOString());
  const landings = [];
  for (const row of rows) {
    let sha;
    try { sha = JSON.parse(row.event_detail)?.sha; } catch { sha = undefined; }
    if (typeof sha === 'string' && sha) landings.push({ sha, at: Date.parse(row.event_at) });
  }
  return landings;
}
