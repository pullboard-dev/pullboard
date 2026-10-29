import { relayRecovered } from '../relay.js';
import { completeMoveHandoff } from '../post-move-handoff.js';
import { prepareStaleObservation } from '../stale-state-command.js';
import { staleReleaseNote } from '../stale-state-policy.js';
import { Refused } from '../refused.js';
import { releaseReasonProblem } from '../release-reasons.js';
/** The pullboard release command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import * as seatCheckout from '../seat-checkout.js';
import {
  nextOnce,
  withBoardRead,
  actOn,
  idArg,
  ordered,
  textArg,
} from '../cli.js';

/** Run `pullboard release` and return its exit code. */
export async function run(io, args) {
  const { first, values } = args;
  const act = (work) => actOn(io, work);
  let releasedContext;
  const code = await act(async (ctx, board, me) => {
  releasedContext = ctx;
  const args = [idArg(first), me.id, textArg(io, values, 'note') ?? ''];
  if (values.stale) {
    if (me.id !== 'coordinator') throw new Refused('NOT_YOURS', 'only the coordinator releases another holder with --stale');
    staleReleaseNote(args[2]);
    const reasonCode = values.reason === undefined ? 'BLOCKED' : values.reason;
    const problem = releaseReasonProblem(reasonCode, args[2]);
    if (problem) throw problem;
    const snapshot = await prepareStaleObservation(ctx, board, ordered, { relayRecovered, specApprovalBaselineExists: store.specApprovalBaselineExists });
    const row = snapshot.claims.find(entry => entry.id === args[0]);
    if (!row) throw new Refused('NOT_YOURS', 'this item has no current claim to release as stale');
    args.push({ staleClaim: row, observedAt: snapshot.observedAt, observedRevision: snapshot.observedRevision, health: ctx.config.health ?? {} }, reasonCode);
  } else {
    seatCheckout.refuseHeldElsewhere(ctx.info, store.listAgents(board), store.getItem(board, args[0]), 'release');
    const missing = releaseReasonProblem(values.reason, args[2]);
    if (missing) throw missing;
    args.push(values.reason);
  }
  const problem = store.reviewReleaseNoteProblem(board, ...args);
  if (problem) throw problem;
  const review = await ordered(ctx, board, 'release', args);
  io.result?.({ id: idArg(first) });
  io.say(review ? `released the review of #${first}; the review is free again` : `released #${first}`);
  return 0;
});
  if (code === 0) await completeMoveHandoff(releasedContext, idArg(first), values, { id: idArg(first) }, { nextOnce, withBoardRead, listItems: store.listItems });
  return code;
}
