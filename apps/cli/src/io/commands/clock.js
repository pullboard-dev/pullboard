/**
 * The pullboard clock command: one clock pass, which applies each due item's registered default move and logs it as a
 * clock_move event [B4,C7]. Not `pullboard sweep`, which files items from a linter run.
 */
import { Refused } from '../../../../../packages/kernel/index.js';
import { clockSweep } from '../../../../../packages/health/index.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import * as store from '../../../../../packages/store/index.js';
import { context } from '../entry.js';
import { withBoard } from '../entry.js';

const USAGE = 'pullboard clock [--dry-run] [--json]';

/** One printed line for a listed move. */
function line(verb, row) {
  const at = row.deadlineAt === undefined ? '' : ` (deadline ${new Date(row.deadlineAt).toISOString()})`;
  return `${verb} #${row.item} ${row.rule}: ${row.move}${row.reason ? ` [${row.reason}]` : ''}${at}`;
}

/** The store moves and coordinator id the clock pass takes as ports. */
function clockPorts() {
  const { listItems, events, getItem, atomic, logEvent, insertShout } = store;
  return { listItems, events, getItem, atomic, logEvent, insertShout, coordinator: COORDINATOR };
}

/** Run `pullboard clock [--dry-run] [--json]` and return its exit code. */
export function run(io, { first, second, rest, values }) {
  if (first || second || rest?.length) throw new Refused('USAGE', 'clock takes no arguments', USAGE);
  const ctx = context(io);
  const dryRun = values['dry-run'] === true;
  const result = withBoard(ctx, board => clockSweep(board, { now: ctx.clock.now().getTime(), dryRun, ports: clockPorts() }));
  io.result?.(result);
  for (const row of result.applied) io.say(line(dryRun ? 'would apply' : 'applied', row));
  for (const row of result.pending) io.say(line('pending', row));
  io.say(`clock ${dryRun ? 'dry run' : 'pass'} at ${result.at}: ${result.applied.length} ${dryRun ? 'would apply' : 'applied'}, ${result.pending.length} pending, ${result.waiting.length} waiting`);
  return 0;
}
