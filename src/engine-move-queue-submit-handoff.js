/** Seal the native immutable job source before any replica receives its queue request [V4,H16]. */
export function prepareBefore(board, values, { ports }) {
  values[1] = ports.sealSubmitHandoffQueue(board, values[0], values[1]);
}
