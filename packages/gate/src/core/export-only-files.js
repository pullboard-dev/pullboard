/** Ratchet export-only files: a file of at most two code lines, all exports, outside a cell's index.js, only falls [C7]. */

/** The ceiling file: every export-only file main still holds. A path may leave it; none may join. */
export const EXPORT_ONLY_CEILINGS = 'packages/gate/export-only-ceilings.json';

/** A cell's own front door, the one place a file of only exports belongs. */
const FRONT_DOOR = /^(?:packages|apps)\/[^/]+\/index\.js$/u;
/** An engine-floor leaf in the state cell's engines folder: one constant per file so two items adding engines never conflict [V4]. */
const ENGINE_LEAF = /^packages\/state\/src\/core\/engines\/[a-z0-9]+(?:-[a-z0-9]+)*-engine\.js$/u;

/**
 * Whether a source is export-only: once comments are gone, one or two code lines, every statement an export.
 * Why: such a file adds a path and an import hop without adding a concept (R33); its exports belong in the module that
 * defines them or in the cell's front door.
 *
 * @param {string} file - Repo-relative path.
 * @param {string} source
 * @returns {boolean}
 */
export function exportOnly(file, source) {
  if (!/\.[cm]?js$/u.test(file) || FRONT_DOOR.test(file) || ENGINE_LEAF.test(file)) return false;
  const lines = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '').split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 2) return false;
  return lines.join(' ').split(/;\s*/u).filter(Boolean).every(statement => /^export\b/u.test(statement));
}

/**
 * One problem per changed file that is export-only and not already in the ceilings.
 *
 * @param {{ file: string, source: string }[]} sources - The changed files that still exist.
 * @param {string[]} allowed - The ceilings file's paths.
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function exportOnlyProblems(sources, allowed) {
  const known = new Set(allowed);
  return sources.filter(({ file, source }) => !known.has(file) && exportOnly(file, source)).map(({ file }) => ({
    path: file, line: 1,
    text: `a new export-only file; export these names from the module that defines them or from the cell's index.js (${EXPORT_ONLY_CEILINGS})`,
  }));
}
