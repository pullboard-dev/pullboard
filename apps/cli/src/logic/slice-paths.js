/** Paths a slice may change are the files it declared, or anything under a declared folder [C7,B26]. */

/** The changed paths that fall outside the declared set; a declared entry covers itself and a folder's contents. */
export function pathsOutsideSlice(changed, declared) {
  const covers = path => declared.some(entry => path === entry || path.startsWith(`${entry.replace(/\/+$/u, '')}/`));
  return changed.filter(path => !covers(path));
}

/** The first sibling slice (same parent, not this item) whose declared set covers the path, or null [C7,B26]. */
export function siblingOwning(path, siblings) {
  return siblings.find(sibling => pathsOutsideSlice([path], sibling.files).length === 0) ?? null;
}

/**
 * The refusal code for a verdict on a slice or a parent while slices.composeLanding is on, or null when the verdict may go ahead [C7].
 * Why: composed slices take one verdict, so a slice is never accepted alone and a parent is not accepted while a slice is still out; a REJECT on a slice stays ordinary and returns only that slice to open.
 * sliceChildren lists the item's own slices as { id, status }; a slice counts as out until it is submitted or verified.
 */
export function sliceVerdictProblem({ decision, isSlice, sliceChildren, composeLanding }) {
  if (composeLanding !== true || decision !== 'ACCEPT') return null;
  if (isSlice) return 'SLICE_REVIEWED_WITH_PARENT';
  const out = (sliceChildren ?? []).some(child => child.status !== 'submitted' && child.status !== 'verified');
  return out ? 'SLICES_PENDING' : null;
}
