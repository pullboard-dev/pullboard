/** The pullboard inbox command separates canonical interrupts from break-time summaries [R2,N26]. */
import { activityDeliveryLines } from '../../../../../packages/activity/index.js';
import { deliverActivity } from '../../../../../packages/activity/index.js';
import { agentDisplayName } from '../context.js';
import { context } from '../context.js';
import { withBoard } from '../context.js';
import { withBoardRead } from '../context.js';
import { evidenceLine } from '../shout.js';
import { startMarksWorker } from '../../../../../packages/jobs/index.js';
import { MARKS_WORKER } from '../inbox-marks-worker.js';
import { whoAmI } from '../join.js';
import { sayLag } from '../lag.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { entryLines } from '../../../../../packages/store/index.js';
import { openEntries } from '../../../../../packages/store/index.js';
import { recordEntryAction } from '../../../../../packages/store/index.js';
import { escalateEntries } from '../../../../../packages/store/index.js';
import { sayQueuedReds } from '../../../../../packages/store/index.js';
import { spoolInboxMarks } from '../../../../../packages/store/index.js';

/**
 * Load the ordered writer only when a read must record something.
 * Why: its module graph pins runner tooling at load, about a second per call that a quiet read never needs (#2421).
 */
async function ordered(...args) {
  return (await import('../claim.js')).ordered(...args);
}

/** Read the feed, or explicitly mark only this recipient's delivered interrupt ids acted on. */
export async function run(io, { values = {} } = {}) {
  const ctx = context(io);
  if (values.history) return history(io, ctx, values);
  if (values.archive !== undefined) return archive(io, ctx, values);
  const actedIds = (values['acted-on'] ?? '').split(',').filter(Boolean);
  const ports = { agentDisplayName, evidenceLine, ordered, whoAmI, withBoard, withBoardRead,
    // inbox.batchedMarks: queued marks go to a background worker that writes them in one batch (#9117).
    handOffMarks: (c, entries) => { if (!entries.length) return; spoolInboxMarks(c.file, entries); startMarksWorker(MARKS_WORKER, c.file); } };
  withBoardRead(ctx, board => sayQueuedReds(io, board, () => whoAmI(ctx, board)));
  sayLag(io, ctx);
  const result = await deliverActivity(ctx, { actedIds }, ports);
  const { agents, ...document } = result;
  io.result?.(document);
  for (const line of activityDeliveryLines(result, ctx.config, ports)) io.say(line);
  // inbox.keepUntilActed: an entry is listed on every read until an action its kind allows is recorded [C7,#8519].
  if (ctx.config.inbox.keepUntilActed === true) {
    const after = ctx.config.inbox.escalateAfterMinutes;
    if (after) await withBoard(ctx, board => escalateEntries(board, { minutes: after, nowMs: ctx.clock.now().getTime(), coordinator: COORDINATOR }));
    const open = withBoardRead(ctx, board => openEntries(board, whoAmI(ctx, board).id));
    for (const line of entryLines(open)) io.say(line);
  }
  return 0;
}

/** Settle inbox entries by archiving them; a kind that does not allow it refuses and records nothing. */
async function archive(io, ctx, values) {
  if (ctx.config.inbox.keepUntilActed !== true) throw new Refused('INBOX_KEEP_OFF', 'inbox entries are not kept until acted on in this project', 'set inbox.keepUntilActed to true to keep and archive them');
  if (values['acted-on'] || values.history) throw new Refused('USAGE', 'pullboard inbox --archive <shout-ids> stands alone');
  const ids = values.archive.split(',').filter(Boolean).map(Number);
  if (!ids.length || !ids.every(Number.isSafeInteger)) throw new Refused('USAGE', 'pullboard inbox --archive takes comma-separated shout ids', 'copy the ids from the entry lines of pullboard inbox');
  await withBoard(ctx, board => { const me = whoAmI(ctx, board); for (const id of ids) recordEntryAction(board, me.id, id, 'archive'); });
  io.result?.({ archived: ids });
  io.say(`archived ${ids.map(id => `#${id}`).join(', ')}`);
  return 0;
}

/** Bytes a history reply reserves for its envelope and closing note, outside its rows. */
const HISTORY_ENVELOPE = 512;

/** One row's printed size: the larger of its indented JSON form and its text line. */
function historySize(row) {
  const json = JSON.stringify(row, null, 2);
  const text = `#${row.shout_id} ${row.shout_at.slice(0, 16)} ${row.shout_from} -> ${row.shout_to}: ${row.shout_text}\n`;
  return Math.max(Buffer.byteLength(json) + 4 * json.split('\n').length + 2, Buffer.byteLength(text));
}

/** Cut one oversized shout's text at a character boundary until its row fits, marking the row as cut. */
function cutHistoryRow(row, room) {
  const marker = ' … (cut to fit the inbox budget)';
  const characters = [...row.shout_text];
  let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...row, shout_text: characters.slice(0, middle).join('') + marker, shout_text_cut: true };
    if (historySize(candidate) <= room) low = middle; else high = middle - 1;
  }
  return { ...row, shout_text: characters.slice(0, low).join('') + marker, shout_text_cut: true };
}

/**
 * Read shouts newer than a shout id, optionally only those to one recipient or of one kind, without delivering,
 * marking or acting on anything. Why: agents ran about 17.7k raw SQL reads of the shout table for exactly this
 * [#1895]. The reply stops at the inbox byte budget and names the id to continue from.
 */
function history(io, ctx, values) {
  if (values['acted-on']) throw new Refused('INBOX_HISTORY_READ_ONLY', 'inbox --history only reads; mark interrupts acted on with pullboard inbox --acted-on <ids> on its own');
  const since = values.since ?? '0';
  if (!/^(?:0|[1-9]\d{0,15})$/u.test(since)) throw new Refused('INBOX_SINCE', `--since takes a shout id, not ${JSON.stringify(since)}; start from 0 or the next id the last read returned`);
  const after = Number(since), to = values.to ?? null, kind = values.kind ?? null;
  const budget = ctx.config.inbox.tokenBudget;
  const read = withBoardRead(ctx, board => {
    // A shout's kind is recorded on its event; only shout events newer than the cursor are read, by index.
    const kinds = new Map();
    if (kind) {
      const events = board.db.prepare("SELECT json_extract(event_detail, '$.shout') AS id, json_extract(event_detail, '$.messageKind') AS kind FROM event WHERE event_kind = 'shout' AND json_extract(event_detail, '$.shout') > ?");
      for (const row of events.all(after)) kinds.set(row.id, row.kind);
    }
    const rows = board.db.prepare(`SELECT shout_id, shout_from, shout_to, shout_text, shout_at FROM shout WHERE shout_id > ?${to ? ' AND shout_to = ?' : ''} ORDER BY shout_id`);
    const shouts = [];
    // The envelope (version, cursor, more) and the closing note take their room first; rows share the rest.
    const room = budget - HISTORY_ENVELOPE;
    let bytes = 0, more = false;
    for (const found of rows.iterate(...(to ? [after, to] : [after]))) {
      if (kind && kinds.get(found.shout_id) !== kind) continue;
      if (shouts.length && bytes + historySize(found) > room) { more = true; break; }
      // A single shout larger than the whole budget is cut to fit and says so; it never overruns the reply.
      const row = historySize(found) > room ? cutHistoryRow(found, room) : found;
      shouts.push(row);
      bytes += historySize(row);
    }
    return { shouts, more };
  });
  const next = read.shouts.at(-1)?.shout_id ?? after;
  io.result?.({ shouts: read.shouts, since: after, next, more: read.more });
  for (const row of read.shouts) io.say(`#${row.shout_id} ${row.shout_at.slice(0, 16)} ${row.shout_from} -> ${row.shout_to}: ${row.shout_text}`);
  if (read.more) io.say(`more: pullboard inbox --history --since ${next}`);
  else if (!read.shouts.length) io.say(`no shouts after #${after}`);
  return 0;
}
