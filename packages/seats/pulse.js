/** Pulse door: a seat's machine-local lookup and command timing, reaching only node: built-ins so a bare heartbeat loads no board graph [C7,#3847]. */
import {
  beginSeatTiming,
  timingSeat,
} from './src/io/timing.js';

/**
 * The seat acting from `cwd` with its command timing already started, or null when no seat is registered there.
 *
 * @param {string} cwd
 * @returns {{ seat: string, board: string, finish(): void } | null}
 */
export function openPulse(cwd) {
  const binding = timingSeat(cwd);
  if (!binding) return null;
  return { seat: binding.seat, board: binding.board, finish: beginSeatTiming(cwd, 'command', 'heartbeat', null, binding) };
}
