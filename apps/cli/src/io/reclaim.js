/** Run the drive cell's fallback reclaim pass for a board command before it answers (RFC 0008 DJ15) [C7]. */
import { lapsedGateJobs } from '../../../../packages/drive/light.js';
import { GATE_DRIVE_KIND } from '../../../../packages/drive/light.js';
import { gateDriveJobId } from '../../../../packages/drive/light.js';
import { withBoardRead } from './board/read.js';
import { writeFallback } from './board/read.js';
import { submitHandoff } from '../../../../packages/store/light.js';
import { reofferInfraEndEnabled } from '../../../../packages/config/light.js';

/**
 * Look for lapsed gate jobs on a read handle and, only when one exists, open the board for writing and drive at
 * most one of them by one transition. Returns the pass's outcome, or null when nothing was lapsed or the pass
 * could not run.
 *
 * Why: the dispatcher reclaims first, and this is the fallback, so it must never fail or slow the command it rides
 * on: a healthy board costs one read, and any error leaves the command's own answer untouched.
 *
 * @param {any} ctx - The command's context.
 * @param {string} command - The command running the pass, named in the driver id.
 * @returns {Promise<Awaited<ReturnType<typeof import('../../../../packages/drive/index.js').reclaimPass>> | null>}
 */
export async function fallbackReclaim(ctx, command) {
  const now = () => ctx.clock.now().getTime();
  try {
    const { lapsed, runs } = await withBoardRead(ctx, async board => {
      const runs = await runsHolder(ctx, board);
      return { runs, lapsed: lapsedGateJobs(board.db, { now: now(), runs }) };
    });
    if (!lapsed.length) return null;
    // The list read above is handed on, so the whole fallback is one reclaimLapsed pass; driveOnce rechecks the lease.
    // A job whose item is no longer submitted at its commit is ended, never renewed (zombie gate jobs, 9 Nov).
    // The drive cell loads only now, when a lapsed job exists: a healthy board never pays for the step machinery (#11941).
    const { reclaimPass } = await import('../../../../packages/drive/index.js');
    return await writeFallback(ctx, board => reclaimPass(board.db, { owner: `fallback:${command}:${process.pid}`, repo: ctx.info.root, now, lapsed, runs,
      active: view => servingNow(board, view), reofferInfraEnd: reofferInfraEndEnabled() }));
  } catch {
    return null;
  }
}

/** The board_meta row that turns the runs file on; the same key as RUNS_STORE_KEY in packages/store, which this light helper must not import statically [P7,#9113]. */
const RUNS_STORE_KEY = 'runs_store';

/**
 * The runs holder while runs_store is on, else null. The store barrel (and its sqlite.js) is imported only when the flag
 * is on, so a default board's next and status load nothing more and open no runs file [P7,#9113].
 *
 * @param {any} ctx
 * @param {any} board - An open board handle.
 * @returns {Promise<{ readonly db: import('node:sqlite').DatabaseSync } | null>}
 */
export async function runsHolder(ctx, board) {
  if (board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(RUNS_STORE_KEY)?.meta_value !== '1') return null;
  return (await import('../../../../packages/store/index.js')).boardRunsHolder(board, ctx.file);
}

/** The id of the newest gate job offered for an item, or null; an older one's receipt would apply as stale. */
function newestGateJob(db, item) {
  return db.prepare("SELECT job_id FROM job WHERE job_kind = 'gate' AND job_item = ? ORDER BY job_created DESC, rowid DESC LIMIT 1").get(item)?.job_id ?? null;
}

/**
 * Whether a gate job's item is still in the state the job serves; null when the job names no item. A job whose item has
 * a queued or running hand-off serves that hand-off: the item must be claimed by the hand-off's seat at its frozen
 * digest, or be submitted at the head that hand-off submitted. A job with no live hand-off serves a submitted item at that head, or a claimed item whose newest gate job it is.
 *
 * Why: during a hand-off gate its item stays claimed, so a submitted-only test would end a live pre-submit gate as
 * stale (#4070, state-machine gap SM4).
 *
 * @param {any} board - The open board.
 * @param {{ id: string, kind: string, item: number | null, candidate: string | null }} view
 * @returns {boolean | null}
 */
export function servingNow(board, view) {
  if (view.item == null) return null;
  const row = board.db.prepare('SELECT item_status, item_owner, item_frozen_digest, item_commit FROM item WHERE item_id = ?').get(view.item);
  if (!row) return false;
  const handoff = submitHandoff(board, view.item);
  // A gate-drive job serves exactly one hand-off: it is stale once that hand-off ended or another replaced it (#4071).
  if (view.kind === GATE_DRIVE_KIND && (!handoff || gateDriveJobId(handoff.id) !== view.id || !['queued', 'running'].includes(handoff.state))) return false;
  if (handoff && ['queued', 'running'].includes(handoff.state)) {
    if (row.item_status === 'claimed') return row.item_owner === handoff.agentId && row.item_frozen_digest === handoff.digest;
    // The item can read submitted at the hand-off's head while the hand-off still reads running; that gate is not stale.
    return row.item_status === 'submitted' && Boolean(handoff.commit) && row.item_commit === handoff.commit;
  }
  // A pulled gate job carries no hand-off record and its item stays claimed until the receipt applies, so the item's
  // newest gate job serves that claim whether or not the builder seat is still running (#8575 was ended stale mid-gate).
  if (row.item_status === 'claimed') return view.kind === 'gate' && newestGateJob(board.db, view.item) === view.id;
  if (row.item_status !== 'submitted') return false;
  // Current means submitted at the head the hand-off submitted, never the job's candidate: a gate's candidate is the
  // composed merge with main, which never equals the item's commit (#3749 was ended stale while submitted).
  const head = handoff?.commit ?? null;
  return !head || !row.item_commit || row.item_commit === head;
}
