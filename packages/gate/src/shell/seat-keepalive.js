/** A long seat command keeps its seat's heartbeat fresh while it runs, so a live seat never reads as gone [B3,C7]. */
import { dirname } from 'node:path';
import { join } from 'node:path';
import { closeBoard } from '../../../store/index.js';
import { heartbeatSeat } from '../../../store/index.js';
import { openBoardForRead } from '../../../store/index.js';
import { timingSeat } from '../../../../src/seat-timing.js';

/** One beat: open the board for read, refresh the seat's presence, close it; a missed beat is retried next tick. */
function defaultBeat(file, seat) {
  let board;
  try {
    board = openBoardForRead(file);
    if (board) heartbeatSeat(board, seat);
  } catch { /* retried on the next tick */ }
  finally { try { if (board) closeBoard(board); } catch { /* already closed */ } }
}

/**
 * Beat this working directory's seat every `everyMs` until the returned stop is called or the process exits; a
 * directory with no seat beats nothing. Why: the seat-gone rule reclaims a claim after two minutes of silence, and a
 * builder's test run is its longest silence: on 6 Nov twenty claims were taken from seats mid-run, and their item
 * folders were removed under them. The timer is unref'd, so it never keeps the run alive.
 */
export function keepSeatAlive(cwd, { everyMs = 60_000, seatOf = timingSeat, beat = defaultBeat, every = setInterval, cancel = clearInterval } = {}) {
  const binding = seatOf(cwd);
  if (!binding?.seat || !binding.file) return () => {};
  const file = join(dirname(binding.file), 'board.sqlite');
  const timer = every(() => beat(file, binding.seat), everyMs);
  timer?.unref?.();
  return () => cancel(timer);
}
