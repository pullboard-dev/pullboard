/** The pullboard trace command: an agent's or an item's timeline from the command trace and the board's events [C7]. */
import { context } from '../entry.js';
import { refusal } from '../entry.js';
import { withBoard } from '../entry.js';
import { readTraceLines } from '../trace.js';
import { sinceCutoff } from '../trace.js';
import { traceLine } from '../trace.js';
import { traceTimeline } from '../trace.js';

const USAGE = 'run pullboard trace <agent|item> [--since 2h] [--json]';

/** Version of the --json document; bump for an incompatible change. */
const TRACE_VERSION = 1;

/** Run `pullboard trace <agent|item>`; it only reads, and prints one line per call or board event in time order. */
export function run(io, { first, second, rest, values }) {
  if (!first || second || rest.length) throw refusal('USAGE', USAGE);
  const since = values.since === undefined ? null : sinceCutoff(values.since);
  if (values.since !== undefined && since === null) throw refusal('USAGE', `--since takes a number and s, m, h or d, like 2h; ${USAGE}`);
  const ctx = context(io);
  const events = withBoard(ctx, board => board.db.prepare('SELECT event_id, event_at, event_by, event_kind, item_id, event_detail FROM event ORDER BY event_id').all());
  const subject = String(first);
  const entries = traceTimeline({ lines: readTraceLines(ctx.info.commonDir), events, subject, since });
  io.result?.({ version: TRACE_VERSION, subject, since: values.since ?? null, entries });
  for (const entry of entries) io.say(traceLine(entry));
  if (!entries.length) io.say(`no calls or events for ${subject}; check the agent id or item number`);
  return 0;
}
