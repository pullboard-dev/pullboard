/** The pullboard expedite command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import {
  COORDINATOR,
} from '../../../../../packages/config/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  actOn,
  idArg,
  ordered,
} from '../entry.js';

/** The most items that may be expedited at once when jobs.expediteMax is not set. */
const DEFAULT_EXPEDITE_MAX = 3;

/** Run `pullboard expedite` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  return actOn(io, async (ctx, board, me) => {
    if (me.id !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator expedites an item');
    const id = idArg(first);
    const reason = String(values.reason ?? [second, ...rest].filter(Boolean).join(' ')).trim();
    if (!reason) throw new Refused('USAGE', 'give the reason: pullboard expedite <id> --reason "<why>"');
    const configured = ctx.config.jobs?.expediteMax;
    const max = Number.isSafeInteger(configured) ? configured : DEFAULT_EXPEDITE_MAX;
    const held = store.expeditedItems(board);
    if (held.length >= max) {
      throw new Refused('EXPEDITE_CAP', `${held.length} items are already expedited and jobs.expediteMax is ${max}; an item stops counting once its gate settles`);
    }
    await ordered(ctx, board, 'expediteItem', [id, { agentId: me.id, reason }]);
    io.result?.({ id, expedited: true, reason });
    io.say(`expedited #${id}: ${reason}`);
    return 0;
  });
}
