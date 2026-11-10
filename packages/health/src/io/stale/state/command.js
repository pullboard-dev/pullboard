/** Bootstrap ordinary coordinator setup before capturing a revision-bound maintenance observation [B4,H16]. */
import { initialSpecApprovalBaseline } from '../../../../../spec/index.js';
import { captureStaleState } from './capture.js';

/** A setup move must never invalidate the observation the requested stale-state move will carry. */
export async function prepareStaleObservation(ctx, board, ordered, ports) {
  const baseline = initialSpecApprovalBaseline(ctx, board, 'maintainStaleState', ports);
  if (baseline) {
    const io = ctx.io.personRequest || ctx.io.personRequestMoveId
      ? { ...ctx.io, personRequest: undefined, personRequestMoveId: undefined } : ctx.io;
    await ordered({ ...ctx, io }, board, 'recordSpecApprovalBaseline', [{ agentId: 'coordinator', baseline }]);
  }
  return captureStaleState(ctx, board);
}
