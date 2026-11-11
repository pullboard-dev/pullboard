import { Refused } from '../../../../../kernel/light.js';

/** A re-home retains its exact source MOVEID [E15,H16]. */
export function prepareBefore(board, values, { id }) {
  if (values[1] && typeof values[1] === 'object') {
    if (values[1].sourceMoveId !== undefined && values[1].sourceMoveId !== id) throw new Refused('RELAY_MOVE', 'a re-home must retain its exact source MOVEID');
    values[1] = { ...values[1], sourceMoveId: id };
  }
}

/** A replayed re-home must name the sealed move it came from [E15,H16]. */
export function replayArgs(board, args, { move }) {
  if (args[1]?.sourceMoveId !== move.id) throw new Refused('RELAY_MOVE', 'a re-home source MOVEID does not match its sealed move');
}
