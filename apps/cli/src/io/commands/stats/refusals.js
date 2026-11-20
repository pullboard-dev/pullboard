/** `pullboard stats refusals`: the recorded refusals counted by code, with the seats and items that hit each most, read-only over the trace lines [C7,#12045]. */
import { Refused } from '../../../../../../packages/kernel/index.js';
import { readTraceLines } from '../../trace.js';
import { sinceCutoff } from '../../trace.js';

/** The most seats or items listed under each top code. */
const TOP = 3;
/** The window the one-line summary of plain `pullboard stats` counts. */
const SUMMARY_WINDOW = '24h';

/** The `count` highest entries of a tally, ties broken by name so the order is stable. */
function top(tally, count) {
  return [...tally].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, count).map(([name, n]) => ({ name, count: n }));
}

/** One more for `key` in a tally map. */
function bump(tally, key) {
  tally.set(key, (tally.get(key) ?? 0) + 1);
}

/**
 * Counts of the refusals among trace lines, highest code first. Each row holds the code, its count and its top seats and
 * items; a line without a refusal, or earlier than `cutoff` (epoch ms), is not counted.
 *
 * Why: the trace line is the one record of a refusal, so counting it needs no table of its own.
 */
export function refusalRows(lines, { cutoff = null } = {}) {
  const codes = new Map();
  for (const line of lines) {
    const code = line?.refusal?.code;
    if (typeof code !== 'string') continue;
    if (cutoff !== null && !(Date.parse(line.at) >= cutoff)) continue;
    const row = codes.get(code) ?? { count: 0, seats: new Map(), items: new Map() };
    row.count += 1;
    bump(row.seats, line.agent ?? 'unknown');
    if (line.item !== null && line.item !== undefined) bump(row.items, `#${line.item}`);
    codes.set(code, row);
  }
  return top(new Map([...codes].map(([code, row]) => [code, row.count])), codes.size)
    .map(({ name, count }) => ({ code: name, count, seats: top(codes.get(name).seats, TOP), items: top(codes.get(name).items, TOP) }));
}

/** The printed lines for refusal rows: one per code, then the top seats and items of the three highest codes. */
export function refusalLines(rows) {
  if (!rows.length) return ['no refusals recorded'];
  const lines = rows.map(row => `${row.code}: ${row.count}`);
  for (const row of rows.slice(0, TOP)) {
    lines.push(`${row.code} seats: ${row.seats.map(s => `${s.name} ${s.count}`).join(', ') || 'none'}`);
    lines.push(`${row.code} items: ${row.items.map(i => `${i.name} ${i.count}`).join(', ') || 'none'}`);
  }
  return lines;
}

/** The one-line summary plain `pullboard stats` prints: `refusals: <n> in 24h, top <CODE> <n>`. */
export function refusalSummary(commonDir, now) {
  const rows = refusalRows(readTraceLines(commonDir), { cutoff: sinceCutoff(SUMMARY_WINDOW, now) });
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return { rows, line: `refusals: ${total} in ${SUMMARY_WINDOW}${rows.length ? `, top ${rows[0].code} ${rows[0].count}` : ''}` };
}

/** Run `pullboard stats refusals [--since 24h] [--json]` and return its exit code; it writes nothing to the board. */
export function runRefusals(io, ctx, { second, rest, values }) {
  if (second !== undefined || rest?.length || values.window !== undefined || values.compare) throw new Refused('USAGE', 'count recorded refusals with pullboard stats refusals [--since 24h] [--json]');
  const now = ctx.clock.now().getTime();
  const cutoff = values.since === undefined ? null : sinceCutoff(values.since, now);
  if (values.since !== undefined && cutoff === null) throw new Refused('USAGE', '--since takes <number><s|m|h|d>, for example pullboard stats refusals --since 24h');
  const refusals = refusalRows(readTraceLines(ctx.info.commonDir), { cutoff });
  io.result?.({ refusals });
  for (const line of refusalLines(refusals)) io.say(line);
  return 0;
}
