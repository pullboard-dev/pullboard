/** The pullboard refreeze command, in its own module so an item adding another command never edits these lines. */
import {
  actOn,
  freezer,
  idArg,
  ordered,
} from '../entry.js';

/** Run `pullboard refreeze` and return its exit code. */
export async function run(io, { first }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const result = await ordered(ctx, board, 'refreeze', [idArg(first), { agentId: me.id, freeze: freezer(ctx, { captureVerifyPolicy: true, board }) }]);
  io.result?.({ id: idArg(first), ...result });
  io.say(`#${first} refrozen ${String(result.before).slice(0, 12)} -> ${result.after.slice(0, 12)}; ${result.unchanged ? 'unchanged; item retained' : result.retainedClaim ? 'claim retained' : 'open again'}`);
  return 0;
});
}
