/** The max-agents series: landings per hour against active builder seats, read only from board events [C7,#9450,#2218]. */
const SYSTEM_ACTORS = ['board', 'person', 'clock', 'coordinator', 'rigor', 'sentinel'];
const HOUR_MS = 3_600_000;
const PLATEAU_SHARE = 0.9;

/**
 * Landings per hour and active seats per hour, with the plateau and the hours spent at it.
 *
 * Why: the write-up's numbers must come from a command a reader can rerun, so the series is a pure read of the event table: the
 * same board and window give the same answer. An hour is on the plateau when it lands at least 90% of the best hour's landings.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{since: string, until: string}} window - ISO UTC timestamps, since inclusive and until exclusive
 * @returns {{command: string, since: string, until: string, hours: {hour: string, landings: number, activeSeats: number}[], plateau: number, plateauHours: number, plateauSeats: number}}
 */
export function readMaxAgentsSeries(db, { since, until }) {
  const from = Date.parse(since), to = Date.parse(until);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new TypeError('readMaxAgentsSeries needs since before until, both ISO UTC timestamps');
  const first = Math.floor(from / HOUR_MS) * HOUR_MS;
  const buckets = new Map();
  for (let at = first; at < to; at += HOUR_MS) buckets.set(at, { hour: new Date(at).toISOString(), landings: 0, seats: new Set() });
  const rows = db.prepare('SELECT event_kind AS kind, event_by AS seat, event_at AS at FROM event WHERE event_at >= ? AND event_at < ? ORDER BY event_id')
    .all(new Date(from).toISOString(), new Date(to).toISOString());
  for (const row of rows) {
    const bucket = buckets.get(Math.floor(Date.parse(row.at) / HOUR_MS) * HOUR_MS);
    if (!bucket) continue;
    if (row.kind === 'merged') bucket.landings += 1;
    if (row.seat && !SYSTEM_ACTORS.includes(row.seat)) bucket.seats.add(row.seat);
  }
  const hours = [...buckets.values()].map(({ hour, landings, seats }) => ({ hour, landings, activeSeats: seats.size }));
  const plateau = Math.max(0, ...hours.map(row => row.landings));
  const onPlateau = plateau > 0 ? hours.filter(row => row.landings >= plateau * PLATEAU_SHARE) : [];
  const plateauSeats = onPlateau.length ? Math.min(...onPlateau.map(row => row.activeSeats)) : 0;
  return { command: `pullboard stats max-agents --since ${since} --until ${until}`, since, until, hours, plateau, plateauHours: onPlateau.length, plateauSeats };
}

/** The series as printed lines, ending with the command that reproduces it. */
export function maxAgentsLines(series) {
  return [
    `max-agents series ${series.since} to ${series.until}`,
    ...series.hours.map(row => `${row.hour}  landings ${row.landings}  active seats ${row.activeSeats}`),
    `plateau ${series.plateau} landings per hour, reached with ${series.plateauSeats} active seats, ${series.plateauHours} hours at the plateau`,
    `reproduce: ${series.command}`,
  ];
}
