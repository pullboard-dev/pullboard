/** The dispatcher's side of the gate drive job: admit each gate's driver on its board, and renew the dispatcher row [C7]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { releaseLease } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { DISPATCHER_JOB } from './dispatcher.js';
import { renewDispatcher } from './dispatcher.js';
import { admitGateDrive } from './gate-drive.js';
import { endGateDriveUnstarted } from './gate-drive.js';
import { readGateDrive } from './gate-drive.js';
import { recordGateDriveSpawn } from './gate-drive.js';
import { gateDriveJobId } from '../core/gate-drive.js';

/** How often the dispatcher renews its job row; the row's lease lapses 2 minutes after the last renewal. */
const ROW_RENEW_MS = 5_000;

/**
 * Run `work` on the board of one repository, or skip it when the repository has no board file.
 * Why skip: a launch names its repository's common directory; a dispatcher must never create a board there.
 *
 * @template T
 * @param {{ openBoard: Function, closeBoard: Function }} opener - The native board opener.
 * @param {string} commonDir - The repository's Git common directory.
 * @param {(board: any) => T} work
 * @returns {T | undefined}
 */
function onBoard({ openBoard, closeBoard }, commonDir, work) {
  const file = join(commonDir, 'pullboard', 'board.sqlite');
  if (!existsSync(file)) return undefined;
  const board = openBoard(file);
  try { return work(board); } finally { closeBoard(board); }
}

/**
 * Whether a recorded driver process is provably gone: a recorded pid that no longer exists.
 *
 * @param {number | null} pid
 * @returns {boolean}
 */
function processGone(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

/**
 * The drive cell's admission for the dispatcher: each gate is admitted to a driver id on its board before its
 * driver process starts, the started process is recorded on the gate's drive job, and a driver that cannot start is
 * recorded there as unstarted. Nothing is written beside the hand-off [C7].
 *
 * @param {{ openBoard: Function, closeBoard: Function, entry?: string }} opener - The board opener and the driver entry
 *   of the dispatcher's own tree, for a gate whose captured tools predate the gate driver.
 * @returns {{ admit: Function, spawned: Function, unstarted: Function, entry: string | null }}
 */
export function createGateAdmission(opener) {
  const { entry } = opener;
  return Object.freeze({
  /**
   * Admit the gate to `owner` before its driver starts. A previous driver whose recorded process is gone gives up
   * its lease first, so a relaunch never waits out the 2 minutes a dead process can no longer renew.
   */
  admit(launch, { owner, relaunches }) {
    onBoard(opener, launch.commonDir, board => {
      const previous = readGateDrive(board.db, launch.job);
      if (previous?.owner && processGone(previous.pid)) releaseLease(board.db, gateDriveJobId(launch.job), previous.owner);
      admitGateDrive(board.db, launch.job, { owner, relaunches });
    });
  },
  /** Record the driver process the dispatcher started. */
  spawned(launch, { owner, pid, started }) { onBoard(opener, launch.commonDir, board => recordGateDriveSpawn(board.db, launch.job, { owner, pid, started })); },
  /** Record why the driver could not start. */
  unstarted(launch, { owner, code, message }) { onBoard(opener, launch.commonDir, board => endGateDriveUnstarted(board.db, launch.job, { owner, code, message })); },
  /** The gate driver of this dispatcher's own tree, for a gate whose captured tools predate it. */
  entry: entry ?? null,
  });
}

/**
 * Renew the dispatcher's job row on the board that launched it, at most every 5 seconds, and free it on exit.
 * Why: the row, not a process check, tells a submit whether a dispatcher runs (RFC 0008 DJ16); a dispatcher that
 * wedges stops renewing, and the next submit launches a fresh one once the 2-minute lease lapses (#2990, #2873).
 *
 * @param {{ openBoard: Function, closeBoard: Function }} opener - The native board opener.
 * @param {string} commonDir - The launching repository's common directory, the dispatcher's working directory.
 * @param {string | undefined} owner - The lease owner the launching submit took the row for.
 * @returns {{ renew: () => void, release: () => void, withDb: <T>(work: (db: import('node:sqlite').DatabaseSync) => T) => T, retake: () => boolean }}
 */
export function gateDispatcherRow(opener, commonDir, owner) {
  let renewedAt = 0;
  return {
    renew() {
      if (!owner || Date.now() - renewedAt < ROW_RENEW_MS) return;
      renewedAt = Date.now();
      onBoard(opener, commonDir, board => renewDispatcher(board.db, owner));
    },
    release() {
      if (owner) onBoard(opener, commonDir, board => releaseLease(board.db, DISPATCHER_JOB, owner));
    },
    /**
     * Take the freed row back under the same owner; false when another submit took it first and launched its own.
     * Why: the row decides who dispatches, so only one of this loop and a fresh launch drains a late ticket.
     */
    /**
     * Run `work` on this dispatcher's board handle. Why: the drive loop finishes gate verdicts waiting on main once
     * their main-test jobs return, on the same board and cadence as the row it renews [C7,#3534].
     *
     * @template T
     * @param {(db: import('node:sqlite').DatabaseSync) => T} work
     * @returns {T}
     */
    withDb(work) {
      return onBoard(opener, commonDir, board => work(board.db));
    },
    retake() {
      if (!owner) return false;
      const taken = onBoard(opener, commonDir, board => takeJob(board.db, DISPATCHER_JOB, owner).taken) === true;
      if (taken) renewedAt = Date.now();
      return taken;
    },
  };
}
