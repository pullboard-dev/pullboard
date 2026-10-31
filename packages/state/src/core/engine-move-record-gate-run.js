/** A gate run is sealed only as its gate's own receipt; a run made up by hand is refused before it reaches any replica. */
export function prepareAfter(board, values, { ports }) {
  ports.requireBound(board, values[0]?.receipt);
}
