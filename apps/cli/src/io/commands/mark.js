/** The pullboard mark command: record one stage mark for an off-board actor, from the closed stage and wait-reason lists [C7,#12157]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { TIMELINE_STAGES } from '../../../../../packages/stats/index.js';
import { WAIT_REASONS } from '../../../../../packages/stats/index.js';
import { randomUUID } from 'node:crypto';
import { replaySpool } from '../mark-spool.js';
import { spoolMark } from '../mark-spool.js';
import { spoolable } from '../mark-spool.js';
import {
  actOn,
  idArg,
  ordered,
} from '../entry.js';

const USAGE = 'pullboard mark <id> <stage> --start|--end|--point [--reason CODE] [--ref x] [--at <ISO time>]';
/** How far from now a mark may sit: a mark more than a day away is a wrong clock or a wrong time. */
const AT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The time a mark names: now, or --at when it is a valid ISO time within 24 h of now.
 * @param {string|undefined} text The --at value.
 * @param {number} now The current time in ms.
 * @returns {number}
 */
function markedAt(text, now) {
  if (text === undefined) return now;
  const at = Date.parse(String(text));
  if (!Number.isFinite(at)) throw new Refused('MARK_AT', `--at ${text} is not a time`, 'give an ISO time such as 2026-11-19T21:30:00Z');
  if (Math.abs(at - now) > AT_WINDOW_MS) throw new Refused('MARK_AT', `--at ${text} is more than 24 h from now`, 'give a time within 24 h of now');
  return at;
}

/** Run `pullboard mark` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  return actOn(io, async (ctx, board, me) => {
    if (!first || !second || rest.length !== 0) throw new Refused('USAGE', USAGE);
    const id = idArg(first);
    const edges = ['start', 'end', 'point'].filter(name => values[name]);
    if (edges.length !== 1) throw new Refused('USAGE', `give exactly one of --start, --end or --point: ${USAGE}`);
    if (!TIMELINE_STAGES.includes(second)) throw new Refused('MARK_STAGE', `${second} is not a stage`, `stages: ${TIMELINE_STAGES.join(', ')}`);
    const reason = values.reason === undefined ? null : String(values.reason);
    if (reason !== null && !WAIT_REASONS.includes(reason)) throw new Refused('MARK_REASON', `${reason} is not a wait reason`, `reasons: ${WAIT_REASONS.join(', ')}`);
    const at = markedAt(values.at, ctx.clock.now().getTime());
    const mark = { agentId: me.id, stage: second, edge: edges[0], reason, ref: values.ref === undefined ? null : String(values.ref), at };
    const line = { id: randomUUID(), item: id, ...mark };
    const write = ({ item, id: markId, agentId, stage, edge, reason: why, ref, at: markAt }) => ordered(ctx, board, 'appendMark', [item, { id: markId, agentId, stage, edge, reason: why, ref, at: markAt }]);
    try {
      await replaySpool(ctx.file, board, write);
      await write(line);
    } catch (error) {
      if (!spoolable(error)) throw error;
      // The board is busy or unreachable: keep the mark with its own time, never lose it and never block the caller.
      spoolMark(ctx.file, line);
      io.result?.({ item: id, mark, spooled: true });
      io.say(`spooled #${id} ${second} ${edges[0]}: the board is busy, the mark is replayed by the next mark that writes`);
      return 0;
    }
    io.result?.({ item: id, mark });
    io.say(`marked #${id} ${second} ${edges[0]}`);
    return 0;
  });
}
