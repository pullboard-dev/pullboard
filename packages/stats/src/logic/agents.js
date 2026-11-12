/** Per-seat flow: claims, submits and landings per hour, and the most items held at once [C7,#6136]. */

/** The board events this view reads. */
export const AGENT_FLOW_KINDS = ['claim', 'submit', 'release', 'merged'];

const HOUR_MS = 3_600_000;

/** The ISO start of the UTC hour holding an instant. */
const hourOf = ms => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString();

/** A count over a window in hours, to two decimals. */
const rate = (count, hours) => Math.round(count / hours * 100) / 100;

/**
 * The most items one seat held at once inside a window.
 *
 * Why: ends sort before starts at the same instant, so a seat that submits one item and claims the next in the same
 * moment holds one, not two.
 *
 * @param {{start: number, end: number}[]} spans - hold intervals, end Infinity while still held
 * @param {number} from - window start, epoch ms
 * @param {number} until - window end, epoch ms
 * @returns {number}
 */
function mostHeld(spans, from, until) {
  const edges = [];
  for (const span of spans) {
    const start = Math.max(span.start, from), end = Math.min(span.end, until);
    if (end > start) { edges.push([start, 1]); edges.push([end, -1]); }
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let held = 0, most = 0;
  for (const [, step] of edges) { held += step; if (held > most) most = held; }
  return most;
}

/**
 * Claims, submits and landings per seat and hour, and the most items each seat held at once, from board events.
 *
 * A seat holds an item from its claim until it submits or releases it, or the item merges. A landing is credited to the
 * seat that last submitted the item (else last claimed it), because the merge event is written by the coordinator.
 * Events before the window still open holds, so a hold that began earlier counts inside the window.
 *
 * @param {{kind: string, seat: string, item: number|null, at: number}[]} events - claim, submit, release and merged events in board order, epoch ms
 * @param {{from: number, until: number}} window - epoch ms
 * @returns {{window: object, seats: object[], unattributedLandings: number}}
 */
export function agentFlow(events, { from, until }) {
  const hours = (until - from) / HOUR_MS;
  const seats = new Map();
  const seatOf = id => {
    if (!seats.has(id)) seats.set(id, { seat: id, claims: 0, submits: 0, landings: 0, byHour: new Map(), spans: [] });
    return seats.get(id);
  };
  const bump = (row, field, at) => {
    row[field] += 1;
    const key = hourOf(at);
    if (!row.byHour.has(key)) row.byHour.set(key, { hour: key, claims: 0, submits: 0, landings: 0 });
    row.byHour.get(key)[field] += 1;
  };
  const open = new Map();
  const builder = new Map();
  let unattributedLandings = 0;
  const close = (item, at) => {
    const hold = open.get(item);
    if (hold) { hold.span.end = at; open.delete(item); }
  };
  for (const event of events) {
    const inside = event.at >= from && event.at < until;
    if (event.item === null || event.item === undefined) continue;
    if (event.kind === 'claim') {
      close(event.item, event.at);
      const span = { start: event.at, end: Infinity };
      seatOf(event.seat).spans.push(span);
      open.set(event.item, { seat: event.seat, span });
      builder.set(event.item, event.seat);
      if (inside) bump(seatOf(event.seat), 'claims', event.at);
    } else if (event.kind === 'submit') {
      close(event.item, event.at);
      builder.set(event.item, event.seat);
      if (inside) bump(seatOf(event.seat), 'submits', event.at);
    } else if (event.kind === 'release') {
      if (open.get(event.item)?.seat === event.seat) close(event.item, event.at);
    } else if (event.kind === 'merged') {
      close(event.item, event.at);
      const owner = builder.get(event.item);
      if (inside) { if (owner) bump(seatOf(owner), 'landings', event.at); else unattributedLandings += 1; }
    }
  }
  const rows = [...seats.values()].map(row => ({
    seat: row.seat, claims: row.claims, submits: row.submits, landings: row.landings,
    claimsPerHour: rate(row.claims, hours), submitsPerHour: rate(row.submits, hours), landingsPerHour: rate(row.landings, hours),
    maxHeld: mostHeld(row.spans, from, until),
    hours: [...row.byHour.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
  })).filter(row => row.claims || row.submits || row.landings || row.maxHeld)
    .sort((a, b) => a.seat.localeCompare(b.seat));
  return { window: { from: new Date(from).toISOString(), until: new Date(until).toISOString(), hours }, seats: rows, unattributedLandings };
}

/** Human lines for the per-seat flow report. */
export function agentFlowLines(report) {
  const lines = [`seat flow over ${report.window.hours}h: ${report.seats.length} seats, ${report.unattributedLandings} landings with no known builder`];
  for (const row of report.seats) {
    lines.push(`${row.seat}: claimed ${row.claims} (${row.claimsPerHour}/h), submitted ${row.submits} (${row.submitsPerHour}/h), landed ${row.landings} (${row.landingsPerHour}/h), most held ${row.maxHeld}`);
  }
  return lines;
}
