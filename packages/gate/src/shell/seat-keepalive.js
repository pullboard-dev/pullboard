/** A long seat command keeps its seat's heartbeat fresh while it runs, so a live seat never reads as gone [B3,C7]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { timingSeat } from '../../../../src/seat-timing.js';

/**
 * One beat: open the board for read, refresh the seat's presence, close it; a missed beat is retried next tick.
 * The store loads on the first beat, so the test runner's static import graph never reaches the board [C7,#3056].
 */
async function defaultBeat(file, seat) {
  let board, store;
  try {
    store = await import('../../../store/index.js');
    const { openBoardForRead, heartbeatSeat } = store;
    board = openBoardForRead(file);
    if (board) heartbeatSeat(board, seat);
  } catch { /* retried on the next tick */ }
  finally { try { if (board) store.closeBoard(board); } catch { /* already closed */ } }
}

/**
 * The seat an item folder belongs to, read from the marker the folder keeps in its own Git metadata, or null.
 * Why: timingSeat only knows a seat's registered checkout, so a test run from an item folder beat nothing and the
 * stale sweep took the claim and removed the folder mid-run (#3430).
 */
export function itemFolderSeat(cwd) {
  try {
    let root = resolve(cwd);
    while (!existsSync(join(root, '.git'))) { const parent = dirname(root); if (parent === root) return null; root = parent; }
    const marker = join(root, '.git');
    if (statSync(marker).isDirectory()) return null;
    const match = /^gitdir:\s*(.+)\s*$/u.exec(readFileSync(marker, 'utf8').trim());
    if (!match) return null;
    const gitDir = resolve(root, match[1]);
    const seat = JSON.parse(readFileSync(join(gitDir, 'pullboard-item.json'), 'utf8'));
    if (seat?.version !== 1 || typeof seat.seat !== 'string') return null;
    const common = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
    return { seat: seat.seat, item: seat.item ?? null, file: join(common, 'pullboard', 'seat-timing.jsonl') };
  } catch { return null; }
}

/** The seat acting from a checkout: the seat registered there, or the seat whose item folder it is. */
export function runSeat(cwd) { return timingSeat(cwd) ?? itemFolderSeat(cwd); }

/**
 * Run `work` with this directory's seat kept alive for exactly as long as it runs, then stop the beat, even when
 * the work throws. A process that dies stops beating, so the sweep still reclaims its claim after two minutes.
 */
export async function whileSeatAlive(cwd, work, options = {}) {
  const stop = keepSeatAlive(cwd, { seatOf: runSeat, ...options });
  try { return await work(); } finally { stop(); }
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
