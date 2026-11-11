/** Seal actual Git paths, owners, diff and native receipts before deterministic replay [B3,L1,V4]. */
export function prepareBefore(board, values, { ports }) {
  values[1] = ports.sealOwnershipWait(board, values[0], values[1]);
}
