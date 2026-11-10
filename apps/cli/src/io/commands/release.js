import { existsSync } from 'node:fs';
import { claimWorktreeSnapshot } from '../../../../../packages/seats/index.js';
import { relayRecovered } from '../../../../../packages/link/index.js';
import { prepareStaleObservation } from '../../../../../packages/health/index.js';
import { pinClaimHandoff } from '../../../../../packages/health/index.js';
import { staleReleaseNote } from '../../../../../packages/store/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { releaseReasonProblem } from '../../../../../packages/store/index.js';
import { cleanItemFolders } from '../item/folder.js';
/** The pullboard release command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import { agentSessionDigest } from '../../../../../packages/person/index.js';
import { refuseHeldElsewhere } from '../../../../../packages/seats/index.js';
import {
  actOn,
  idArg,
  ordered,
  textArg,
  editAfter,
} from '../entry.js';

/**
 * A seat whose session ends releases its build claims at once (#1225), keeping its work at a board ref, so no claim
 * waits out the idle clock after its agent has gone. Run by the SessionEnd hook; a seat may also run it on exit.
 */
async function releaseOnSessionEnd(io) {
  return actOn(io, async (ctx, board, me) => {
    const held = store.itemsInStatus(board, 'claimed', me.id).filter(item => item.item_parent_id === null);
    const released = [];
    for (const item of held) {
      const handoff = pinClaimHandoff(board, { id: item.item_id, actor: me.id }, item);
      const shown = handoff.changedFiles.slice(0, 8);
      const more = handoff.changedCount - shown.length;
      const note = `session ended; ${handoff.pin ? `work kept at ${handoff.pin} (${handoff.changedCount} file(s): ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''})` : `no work could be pinned: ${handoff.unpinned}`}`;
      await ordered(ctx, board, 'release', [item.item_id, me.id, note, { worktreeSnapshot: claimWorktreeSnapshot(ctx.info.root) }, 'OTHER']);
      released.push(item.item_id);
    }
    cleanItemFolders(ctx, board, me);
    io.result?.({ released });
    io.say(released.length ? `session ended: released ${released.map(id => `#${id}`).join(', ')}` : 'session ended: no build claim to release');
    return 0;
  });
}

/** Run `pullboard release` and return its exit code. */
export async function run(io, args) {
  const { first, values } = args;
  if (values['session-end'] === true) return releaseOnSessionEnd(io);
  const act = (work) => actOn(io, work);
  const code = await act(async (ctx, board, me) => {
  const args = [idArg(first), me.id, textArg(io, values, 'note') ?? ''];
  if (values.on !== undefined && (values.reason !== 'BLOCKED' || values.stale)) throw new Refused('USAGE', '--on requires an ordinary release with --reason BLOCKED');
  const blockedOn = values.on === undefined ? undefined : editAfter(values.on);
  if (blockedOn && (!blockedOn.length || blockedOn.some(value => typeof value !== 'number'))) throw new Refused('BAD_DEPENDENCIES', '--on needs one or more local item ids');
  if (values.stale) {
    if (me.id !== 'coordinator') throw new Refused('NOT_YOURS', 'only the coordinator releases another holder with --stale');
    const reasonCode = values.reason;
    const problem = releaseReasonProblem(reasonCode, args[2]);
    if (problem) throw problem;
    staleReleaseNote(args[2]);
    const snapshot = await prepareStaleObservation(ctx, board, ordered, { relayRecovered: (root, options) => relayRecovered(root, options, ctx.io), specApprovalBaselineExists: store.specApprovalBaselineExists });
    const row = snapshot.claims.find(entry => entry.id === args[0]);
    if (!row) throw new Refused('NOT_YOURS', 'this item has no current claim to release as stale');
    // The holder's folder is gone: capture its path so the release needs no stale interval (#3223).
    const seatPath = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(row.actor)?.agent_path;
    const observed = seatPath && !existsSync(seatPath) ? { ...row, seatFolderMissing: seatPath } : row;
    args.push({ leaseLapse: true, staleClaim: observed, observedAt: snapshot.observedAt, observedRevision: snapshot.observedRevision, health: ctx.config.health ?? {} }, reasonCode);
  } else {
    refuseHeldElsewhere(ctx.info, store.listAgents(board), store.getItem(board, args[0]), 'release', agentSessionDigest);
    const missing = releaseReasonProblem(values.reason, args[2]);
    if (missing) throw missing;
    args.push({ ...(blockedOn ? { blockedOn } : {}), worktreeSnapshot: claimWorktreeSnapshot(ctx.info.root) }, values.reason);
  }
  const problem = store.reviewReleaseNoteProblem(board, ...args);
  if (problem) throw problem;
  const review = await ordered(ctx, board, 'release', args);
  cleanItemFolders(ctx, board, me);
  if (!review && ctx.config.worktreeMaintenance?.enabled === true) {
    const { cleanupMaintenanceLifecycle } = await import('../worktree/maintenance/command.js');
    await cleanupMaintenanceLifecycle(ctx, me.id, { path: ctx.info.root, item: idArg(first), agent: me.id });
  }
  io.result?.({ id: idArg(first) });
  io.say(review ? `released the review of #${first}; the review is free again` : `released #${first}`);
  return 0;
});
  return code;
}
