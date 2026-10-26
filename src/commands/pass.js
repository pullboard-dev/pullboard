/** The pullboard pass command, in its own module so an item adding another command never edits these lines. */
import {
  laneNames,
} from '../lanes.js';
import {
  actOn,
  idArg,
  ordered,
} from '../cli.js';

/** Run `pullboard pass` and return its exit code. */
export async function run(io, { first, second, rest }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const id = await ordered(ctx, board, 'passDecision', [idArg(first), { agentId: me.id, note: [second, ...rest].filter(Boolean).join(' '), lanes: laneNames(ctx.config) }]);
  io.result?.({ id, answers: idArg(first) });
  io.say(`passed #${first} upward as #${id}`);
  return 0;
});
}
