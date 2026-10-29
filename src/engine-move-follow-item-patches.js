/** Seal the followed patch set at its origin [C7,H16]. */
export function prepareBefore(board, values, { ports }) {
  values[1] = ports.sealItemPatchFollow(board, values[0], values[1]);
}
