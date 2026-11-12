/** Validated flow-window time bounds, shared by seat capacity and the stats cell above it [R1,R2,C7]. */
import { Refused } from '../../../kernel/browser.js';

const MINUTE = 60_000;

/**
 * Share exact validated window boundaries with line-capacity decisions and stats windows.
 *
 * It sits below both cells so seat capacity reads the same bounds and refusal as pullboard stats
 * without loading the stats cell.
 */
export function flowWindowBounds(minutes, now) {
  if (!(minutes > 0) || !Number.isFinite(minutes) || !Number.isFinite(new Date(now - minutes * MINUTE).getTime())) {
    throw new Refused('USAGE', 'use pullboard stats --window with a positive finite duration, for example --window 6h');
  }
  const since = now - minutes * MINUTE;
  return { since: new Date(since).toISOString(), until: new Date(now).toISOString(), durationMinutes: minutes };
}
