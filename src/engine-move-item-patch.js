/** A patch attached to or removed from a claimed item is marked presubmit for every replica. */
export function prepareBefore(board, values, { store }) {
  if (store.getItem(board, values[0]).item_status === 'claimed') {
    values[1] = { ...values[1], presubmit: true };
  }
}
