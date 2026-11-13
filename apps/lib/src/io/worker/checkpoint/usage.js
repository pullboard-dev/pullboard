/** Drain due usage checkpoints so no board command waits on usage accounting; the cli entry runs it detached [N2,B3,C7]. */

/**
 * Drain every due checkpoint of one repository, each as the seat whose checkout queued it.
 * Why: each runs with the move's own time, last event and session environment, so totals match the in-line checkpoint.
 * The board context, board opener and move orderer are cli bindings, so the cli entry passes them as ports [C7].
 *
 * @param {string} commonDir the repository's Git common directory
 * @param {{ context: Function, withBoard: Function, ordered: Function }} ports the caller's cli bindings
 */
export async function runUsageCheckpointWorker(commonDir, { context, withBoard, ordered }) {
  const nativeBoard = await import('../../../logic/native.js');
  const { drainUsageCheckpoints, publishUsage } = await import('../../../../../../packages/stats/index.js');
  await drainUsageCheckpoints(commonDir, async (request) => {
    const ctx = context({ cwd: request.root, nativeBoard, say() {}, err() {} });
    await withBoard(ctx, board => publishUsage(ctx, board, { agent: request.agent, item: request.item, operation: request.operation },
      { drain: true, ordered, now: request.now, lastEventId: request.lastEventId, environment: request.environment }));
  });
}
