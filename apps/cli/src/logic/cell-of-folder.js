/** A module's cell comes from its folder alone: packages/<name> is cell <name>, apps/<name> is cell app:<name> [C7,#8554]. */

/**
 * The cell that owns a repo path, or null when the path sits in no package or app folder.
 *
 * Why: the restructure plan used to be the only way to name a path's cell; the folder already says it.
 *
 * @param {string} file repo-relative path
 * @returns {string | null}
 */
export function cellOfFolder(file) {
  const [top, name, ...rest] = String(file).split('/');
  if (!name || !rest.length) return null;
  if (top === 'packages') return name;
  if (top === 'apps') return `app:${name}`;
  return null;
}
