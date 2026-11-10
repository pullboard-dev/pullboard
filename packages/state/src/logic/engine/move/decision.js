/** Implied facts take their ids from the sealed move, so every replica writes the same ones. */
export function replayArgs(board, args, { move }) {
  if (args[1] && typeof args[1] === 'object' && !Array.isArray(args[1])) args[1].impliesId = move.id;
}
