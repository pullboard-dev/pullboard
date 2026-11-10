/** The pullboard escalate command, in its own module so an item adding another command never edits these lines. */
import {
  COORDINATOR,
} from '../../../../../packages/config/index.js';
import {
  laneNames,
} from '../../../../../packages/seats/index.js';
import {
  actOn,
  idArg,
  ordered,
  textArg,
} from '../entry.js';

/** Run `pullboard escalate` and return its exit code. */
export async function run(io, { first, values }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const id = idArg(first);
  const note = textArg(io, values, 'note') ?? '';
  const moved = await ordered(ctx, board, 'escalate', [id, { agentId: me.id, note }]);
  if (me.id !== COORDINATOR) {
    await ordered(ctx, board, 'shout', [{ from: me.id, to: COORDINATOR, text: `#${id} escalated ${moved.from} -> ${moved.to}: ${note}`, lanes: laneNames(ctx.config) }]);
  }
  io.result?.({ id, ...moved });
  io.say(`#${id} escalated ${moved.from} -> ${moved.to}; it is open for a ${moved.to} agent`);
  return 0;
});
}
