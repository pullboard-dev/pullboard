/** The pullboard timeline command: one item's timeline, or the fleet's, from the stats readers; it only reads [C7,#12148]. */
import { context } from '../entry.js';
import { refusal } from '../entry.js';
import { withBoardRead } from '../context.js';
import { fleetSummary } from '../../../../../packages/stats/index.js';
import { readFleetTimelines } from '../../../../../packages/stats/index.js';
import { readItemTimeline } from '../../../../../packages/stats/index.js';
import { sinceCutoff } from '../trace.js';

const USAGE = 'run pullboard timeline <id> [--json] or pullboard timeline --fleet [--since 3h] [--json]';

/** Version of the --json document; bump for an incompatible change. */
const TIMELINE_VERSION = 1;

/** Milliseconds as a short span such as 5m 20s. */
function span(ms) {
  const total = Math.round(Math.abs(ms) / 1000);
  const parts = [[Math.floor(total / 3600), 'h'], [Math.floor(total / 60) % 60, 'm'], [total % 60, 's']].filter(([n]) => n > 0).map(([n, unit]) => `${n}${unit}`);
  return parts.length ? parts.join(' ') : '0s';
}

/** The non-zero entries of a share table as "name 12.3%" parts. */
const sharesOf = table => Object.entries(table).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).map(([name, value]) => `${name} ${value.toFixed(1)}%`).join(', ') || 'none';

/** The lines of one item's timeline: a row per stage with its delta, then the bucket summary and the longest gap. */
function itemLines({ rows, summary }) {
  const lines = rows.map(row => `${new Date(row.at).toISOString()}  ${row.delta === null ? '' : `+${span(row.delta)}`}  ${row.stage}  ${row.actor ?? ''}  ${row.reason ?? ''}  ${row.ref ?? ''}`.replace(/\s+$/u, ''));
  const buckets = Object.entries(summary.buckets).filter(([, ms]) => ms > 0).map(([name, ms]) => `${name} ${span(ms)}`).join(', ') || 'none';
  lines.push(`total ${span(summary.total_ms)}; ${buckets}; UNACCOUNTED ${span(summary.unaccounted_ms)}`);
  if (summary.longest_gap) lines.push(`longest gap ${span(summary.longest_gap.ms)}: ${summary.longest_gap.reason}`);
  return lines;
}

/** The lines of the fleet summary: stage medians, shares, gates per landed item and the slowest items. */
function fleetLines(summary) {
  const lines = [`${summary.items} items, ${summary.landed} landed, ${span(summary.total_ms)} of item-time`];
  for (const [stage, value] of Object.entries(summary.stages)) lines.push(`stage ${stage}: median ${span(value.median_ms)}, p90 ${span(value.p90_ms)} (${value.count})`);
  lines.push(`bucket share: ${sharesOf(summary.share.buckets)}`, `wait share: ${sharesOf(summary.share.waits)}; UNACCOUNTED ${summary.share.UNACCOUNTED.toFixed(1)}%`);
  lines.push(`gates per landed item: ${summary.gates_per_landed === null ? 'none landed' : summary.gates_per_landed.toFixed(2)}`);
  for (const entry of summary.slowest) lines.push(`slowest #${entry.item}: ${span(entry.total_ms)}${entry.biggest_gap ? `, biggest gap ${span(entry.biggest_gap.ms)} ${entry.biggest_gap.reason}` : ''}`);
  return lines;
}

/** Run `pullboard timeline`; it reads board rows only and prints text, or the --json document. */
export function run(io, { first, second, rest, values }) {
  const fleet = values.fleet !== undefined;
  if (second || rest.length || (fleet ? first !== undefined : !/^\d+$/u.test(String(first ?? '')))) throw refusal('USAGE', USAGE);
  const ctx = context(io);
  if (!fleet) {
    const id = Number(first);
    const timeline = withBoardRead(ctx, board => readItemTimeline(board, id, { now: ctx.clock.now().getTime() }));
    if (!timeline.rows.length) throw refusal('NO_SUCH_ITEM', `no events for #${id}; check the item number with pullboard show`);
    io.result?.({ version: TIMELINE_VERSION, item: id, rows: timeline.rows, summary: timeline.summary, unmapped: timeline.unmapped });
    for (const line of itemLines(timeline)) io.say(line);
    return 0;
  }
  const window = values.since === undefined || values.since === true ? '3h' : values.since;
  const now = ctx.clock.now().getTime();
  const since = sinceCutoff(window, now);
  if (since === null) throw refusal('USAGE', `--since takes a number and s, m, h or d, like 3h; ${USAGE}`);
  const summary = withBoardRead(ctx, board => {
    const read = readFleetTimelines(board, { since, now });
    return fleetSummary(read.timelines, read.fleetRows);
  });
  io.result?.({ version: TIMELINE_VERSION, since: window, summary });
  for (const line of fleetLines(summary)) io.say(line);
  return 0;
}
