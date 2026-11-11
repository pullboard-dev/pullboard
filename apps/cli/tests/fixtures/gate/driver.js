/** Read and set a submit gate's driver record, the drive job the dispatcher writes on the board, in tests [C7]. */
import { openBoard } from '../../../../lib/index.js';
import { admitGateDrive } from '../../../../../packages/drive/index.js';
import { endGateDriveUnstarted } from '../../../../../packages/drive/index.js';
import { readGateDrive } from '../../../../../packages/drive/index.js';
import { recordGateDriveSpawn } from '../../../../../packages/drive/index.js';
import { RUNNING_RELAUNCH_LIMIT } from '../../../src/io/submit/handoff.js';

/**
 * Run `work` on a fixture's own board file and close it.
 *
 * @template T
 * @param {string} boardFile
 * @param {(board: any) => T} work
 * @returns {T}
 */
function onBoard(boardFile, work) {
  // @pullboard-board-file journey: read or set the fixture's own drive job rows, as the dispatcher writes them.
  const board = openBoard(boardFile);
  try { return work(board); } finally { board.db.close(); }
}

/**
 * The gate's driver record (owner, pid, exact start, relaunches), or null before the dispatcher admitted it.
 *
 * @param {string} boardFile
 * @param {string} job - The hand-off job id.
 * @returns {ReturnType<typeof readGateDrive>}
 */
export function driverRecord(boardFile, job) {
  return onBoard(boardFile, board => readGateDrive(board.db, job));
}

/**
 * Record a driver process for the gate's current admission, admitting it first when no driver was admitted; the
 * latest record is the one every reader judges.
 *
 * @param {string} boardFile
 * @param {string} job - The hand-off job id.
 * @param {{ pid: number, started?: string | null }} process - The process to name.
 */
export function setDriverProcess(boardFile, job, { pid, started = null }) {
  onBoard(boardFile, board => {
    let record = readGateDrive(board.db, job);
    if (!record) record = admitGateDrive(board.db, job, { owner: `test-driver:${job}` });
    recordGateDriveSpawn(board.db, job, { owner: record.owner, pid, started });
  });
}

/**
 * Record that the gate's driver never started, as the dispatcher does when its tools are gone.
 *
 * @param {string} boardFile
 * @param {string} job - The hand-off job id.
 * @param {{ code: string, message: string }} reason
 */
export function setDriverUnstarted(boardFile, job, { code, message }) {
  onBoard(boardFile, board => {
    const record = readGateDrive(board.db, job) ?? admitGateDrive(board.db, job, { owner: `test-driver:${job}` });
    endGateDriveUnstarted(board.db, job, { owner: record.owner, code, message });
  });
}

/**
 * Mark a dead driver's relaunch budget as spent, as the real relaunches that each died would leave it: the next
 * sweep then ends the running gate as infrastructure instead of relaunching it (#3995). The dead process is kept.
 *
 * @param {string} boardFile
 * @param {string} job - The hand-off job id.
 */
export function spendDriverRelaunches(boardFile, job) {
  onBoard(boardFile, board => {
    const record = readGateDrive(board.db, job);
    // Admit at a time past the dead driver's lease, so the board takes the lease over without a release call.
    const owner = `test-driver:${job}`;
    admitGateDrive(board.db, job, { owner, relaunches: RUNNING_RELAUNCH_LIMIT, now: Date.now() + 10 * 60_000 });
    recordGateDriveSpawn(board.db, job, { owner, pid: record.pid, started: record.started });
  });
}
