import { Refused } from '../../../../../kernel/light.js';

/** A replayed fact takes its id from the sealed move, so every replica writes the same one. */
export function replayArgs(board, args, { move }) {
  if (!args[1] || typeof args[1] !== 'object' || Array.isArray(args[1])) throw new Refused('RELAY_MOVE', 'a fact needs its typed arguments; use the current Pullboard engine');
  args[1].factId = move.id;
}

/**
 * A queued fact made on this machine before the relay orders it takes the same id its replay writes, so the id
 * the command returned stays the fact's id on every replica and a later supersedes of it still resolves (GitHub #30).
 */
export function localArgs(args, { move }) {
  if (Array.isArray(args) && args[1] && typeof args[1] === 'object' && !Array.isArray(args[1])) args[1].factId = move.id;
}
