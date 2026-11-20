/** A long seat command keeps its seat's heartbeat fresh while it runs, so a live seat never reads as gone [B3,C7]. */
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileSystemAdapter } from '../../../fs/index.js';
import { timingSeat } from '../../../seats/light.js';

const fs = fileSystemAdapter();

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
    while (!fs.exists(join(root, '.git'))) { const parent = dirname(root); if (parent === root) return null; root = parent; }
    const marker = join(root, '.git');
    if (fs.stat(marker).isDirectory()) return null;
    const match = /^gitdir:\s*(.+)\s*$/u.exec(fs.readFile(marker, 'utf8').trim());
    if (!match) return null;
    const gitDir = resolve(root, match[1]);
    const seat = JSON.parse(fs.readFile(join(gitDir, 'pullboard-item.json'), 'utf8'));
    if (seat?.version !== 1 || typeof seat.seat !== 'string') return null;
    const common = resolve(gitDir, fs.readFile(join(gitDir, 'commondir'), 'utf8').trim());
    return { seat: seat.seat, item: seat.item ?? null, file: join(common, 'pullboard', 'seat-timing.jsonl') };
  } catch { return null; }
}

/** The seat acting from a checkout: the seat registered there, or the seat whose item folder it is. */
export function runSeat(cwd) { return timingSeat(cwd) ?? itemFolderSeat(cwd); }

/** The board file beside a seat binding's file: every seat file lives in the board's own folder. */
function seatBoard(binding) { return join(dirname(binding.file), 'board.sqlite'); }

/** Beat once for the seat acting from `cwd`, its checkout or item folder; a directory with no seat beats nothing. */
export async function beatSeat(cwd, { seatOf = runSeat, beat = defaultBeat } = {}) {
  const binding = seatOf(cwd);
  if (binding?.seat && binding.file) await beat(seatBoard(binding), binding.seat);
}

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
  const file = seatBoard(binding);
  const timer = every(() => beat(file, binding.seat), everyMs);
  timer?.unref?.();
  return () => cancel(timer);
}

/**
 * Whether `seat` still holds a claim on the board in `file`; an item in its queued gate stays claimed, so this covers gates too.
 * A seat whose registered worktree is gone holds nothing it can work on, so its beat ends and the seat-gone sweep takes the claim.
 * A board that cannot be read this tick counts as held, so a busy writer never ends the beat early; a missing board holds nothing.
 */
async function defaultHeld(file, seat) {
  let board, store;
  try {
    store = await import('../../../store/index.js');
    board = store.openBoardForRead(file);
    if (!board) return false;
    const path = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(seat)?.agent_path;
    if (typeof path === 'string' && !fs.exists(path)) return false;
    return Boolean(board.db.prepare("SELECT 1 FROM item WHERE item_status='claimed' AND item_owner=? LIMIT 1").get(seat));
  } catch { return true; }
  finally { try { if (board) store.closeBoard(board); } catch { /* already closed */ } }
}

/** Resolve after `ms` without keeping the process alive past its work. */
function pause(ms) { return new Promise(done => setTimeout(done, ms)); }

/**
 * Beat this directory's seat through heartbeatSeat while it holds any claim or queued gate, then return once it holds none.
 * `alive` ends the beat early: the claim beater passes its agent session's liveness, so a dead agent stops beating.
 * Why: coordinators ran five shell loops that read item_owner and agent_path straight from SQLite with different seat rules;
 * one command keeps every claim of a seat alive on the same path the test runner's keepalive uses [B3,C7,#3784].
 *
 * @param {string} cwd the seat checkout or one of its item folders
 * @returns {Promise<{ seat: string|null, beats: number }>}
 */
export async function keepClaimsAlive(cwd, { everyMs = 30_000, seatOf = runSeat, held = defaultHeld, beat = defaultBeat, wait = pause, alive = () => true } = {}) {
  const binding = seatOf(cwd);
  if (!binding?.seat || !binding.file) return { seat: null, beats: 0 };
  const file = seatBoard(binding);
  let beats = 0;
  while (alive() && await held(file, binding.seat)) {
    await beat(file, binding.seat);
    beats += 1;
    await wait(everyMs);
  }
  return { seat: binding.seat, beats };
}
