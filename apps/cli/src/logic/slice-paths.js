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
