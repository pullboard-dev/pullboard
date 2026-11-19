import { existsSync } from 'node:fs';
import { claimWorktreeSnapshot } from '../../../../../packages/seats/index.js';
import { relayRecovered } from '../../../../../packages/link/index.js';
import { staleReleaseNote } from '../../../../../packages/store/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { releaseReasonProblem } from '../../../../../packages/store/index.js';
import { reviewReleaseReasonsRequired } from '../../../../../packages/config/index.js';
import { releaseStaleItemRevision } from '../../../../../packages/config/index.js';
import { cleanItemFolders } from '../item/folder.js';
/** The pullboard release command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import { agentSessionDigest } from '../../../../../packages/person/index.js';
import { refuseHeldElsewhere } from '../../../../../packages/seats/index.js';
import { actOn } from '../board/access.js';
import { ordered } from '../claim.js';
import { idArg } from '../context.js';
import {
  editAfter,
  textArg,
} from '../read.js';

/**
 * A seat whose session ends releases its build claims at once (#1225), keeping its work at a board ref, so no claim
 * waits out the idle clock after its agent has gone. Run by the SessionEnd hook; a seat may also run it on exit.
 */
async function releaseOnSessionEnd(io) {
  return actOn(io, async (ctx, board, me) => {
    const held = store.itemsInStatus(board, 'claimed', me.id).filter(item => item.item_parent_id === null);
    const released = [];
    for (const item of held) {
      const { pinClaimHandoff } = await import('../../../../../packages/health/index.js');
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

/** How long past its lease a dead seat's claim must be before a coordinator stale release compares only its own item's events [C7,#12005]. */
export const DEAD_SEAT_LAPSE_MS = 120 * 60_000;
/** A seat with a heartbeat or a board event this recent is live. */
const LIVE_SEAT_MS = 2 * 60_000;

/**
 * Whether an observed claim is a dead seat's: its lease lapsed more than DEAD_SEAT_LAPSE_MS before the observation, and its
 * holder has neither a heartbeat nor a board event in the last two minutes [C7,#12005].
 * Why: the stale capture takes minutes on a busy board while other seats write events, so the board-wide revision check
 * refused every dead seat's claim; the claim's own revision still refuses a holder that comes back.
 *
 * @param {any} board
 * @param {{ actor?: string, leaseUntil?: string, heartbeatAt?: string|null }} row The captured claim row.
 * @param {string} observedAt The observation instant.
 * @returns {boolean}
 */
export function deadSeatClaim(board, row, observedAt) {
  const at = Date.parse(observedAt ?? ''), lease = Date.parse(row?.leaseUntil ?? '');
  if (!Number.isFinite(at) || !Number.isFinite(lease) || at - lease <= DEAD_SEAT_LAPSE_MS) return false;
  const latest = board.db.prepare('SELECT MAX(event_at) AS at FROM event WHERE event_by=?').get(row.actor)?.at;
  return ![row.heartbeatAt, latest].some(value => {
    const seen = Date.parse(value ?? '');
    return Number.isFinite(seen) && at - seen < LIVE_SEAT_MS;
  });
}

/**
 * The captured observation a coordinator --stale release carries; an itemRevision scopes its revision check to the item.
 *
 * @param {object} row The captured claim row.
 * @param {{ observedAt: string, observedRevision: number }} snapshot The stale-state capture.
 * @param {number|undefined} itemRevision The item's own revision read before the capture, or undefined for the board-wide check.
 * @param {object} health The project's health settings.
 */
export function staleObservation(row, snapshot, itemRevision, health) {
  return { leaseLapse: true, staleClaim: row, observedAt: snapshot.observedAt, observedRevision: snapshot.observedRevision,
    ...(itemRevision === undefined ? {} : { itemRevision }), health };
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
    // The item's own revision, read before the observation so any later event on it still refuses (#10598). It is used with
    // release.staleItemRevision on, or for a dead seat's claim lapsed past DEAD_SEAT_LAPSE_MS (#12005).
    const itemRevision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM event WHERE item_id=?').get(args[0]).id;
    const { prepareStaleObservation } = await import('../../../../../packages/health/index.js');
    const snapshot = await prepareStaleObservation(ctx, board, ordered, { relayRecovered: (root, options) => relayRecovered(root, options, ctx.io), specApprovalBaselineExists: store.specApprovalBaselineExists });
    const row = snapshot.claims.find(entry => entry.id === args[0]);
    if (!row) throw new Refused('NOT_YOURS', 'this item has no current claim to release as stale');
    // The holder's folder is gone: capture its path so the release needs no stale interval (#3223).
    const seatPath = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(row.actor)?.agent_path;
    const observed = seatPath && !existsSync(seatPath) ? { ...row, seatFolderMissing: seatPath } : row;
    const scoped = releaseStaleItemRevision() || deadSeatClaim(board, observed, snapshot.observedAt);
    args.push(staleObservation(observed, snapshot, scoped ? itemRevision : undefined, ctx.config.health ?? {}), reasonCode);
  } else {
    refuseHeldElsewhere(ctx.info, store.listAgents(board), store.getItem(board, args[0]), 'release', agentSessionDigest);
    const item = store.getItem(board, args[0]);
    const isReview = item.item_status === 'submitted' && store.reviewHolder(board, item) === me.id;
    // A review's reason may be typed as `too large` or `too-large`; the recorded code is the upper-case form [C7,#8920].
    const typed = typeof values.reason === 'string' ? values.reason.trim().toUpperCase().replace(/[\s-]+/gu, '_') : values.reason;
    if (isReview && store.REVIEW_RELEASE_REASONS.includes(typed)) values.reason = typed;
    if (isReview && reviewReleaseReasonsRequired() && !store.REVIEW_RELEASE_REASONS.includes(values.reason)) {
      throw new Refused('REVIEW_RELEASE_REASON', `a review release names why it was dropped: --reason ${store.REVIEW_RELEASE_REASONS.join('|')} (--note still gives the one-line reason)`, 'run pullboard release <id> --reason BAR|FAMILY|INFRA|TOO_LARGE --note "why"');
    }
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
