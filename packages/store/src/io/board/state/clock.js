/**
 * The clock health document the board state carries, so the watch can show the clock invariant [B4,C7].
 * Why: the clock pass stores its document in board meta; the view reads the state, not the meta table.
 */
import { readBoardMeta } from '../meta.js';

/** Board meta key where the clock pass stores its health document (the same key packages/health writes). */
const CLOCK_HEALTH_META_KEY = 'clock.health';

/** The stored clock health document as is, or null when no clock pass has stored one (or the stored text is not JSON). */
export function boardStateClock(db) {
  const text = readBoardMeta(db, CLOCK_HEALTH_META_KEY);
  if (text === undefined) return null;
  try { return JSON.parse(text); } catch { return null; }
}
