/** Which open items' red gates failed on a Main red's file and case [C7,#1269]. */

/** The key a failure row is compared by: its file and case name. */
function failureKey({ file, name }) {
  return `${file}\u0000${name}`;
}

/**
 * The id of each item whose latest red gate failures include the red's file and case name.
 * Why: when a Main red is fixed, the items it blocked are told, and an item that failed another file or case is not.
 * @param {{ file: string, name: string }} red
 * @param {{ id: number, failures: { file: string, name: string }[] }[]} itemReds
 */
export function itemsFailedOn(red, itemReds) {
  const wanted = failureKey(red);
  return itemReds
    .filter(({ failures }) => (failures ?? []).some(failure => failureKey(failure) === wanted))
    .map(({ id }) => id);
}
