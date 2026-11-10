import { Refused } from '../../../../../kernel/light.js';

/** A replayed fact takes its id from the sealed move, so every replica writes the same one. */
export function replayArgs(board, args, { move }) {
  if (!args[1] || typeof args[1] !== 'object' || Array.isArray(args[1])) throw new Refused('RELAY_MOVE', 'a fact needs its typed arguments; use the current Pullboard engine');
  args[1].factId = move.id;
}
