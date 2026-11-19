/** Ratchet export-only files: a file of at most two code lines, all exports, outside a cell's index.js, only falls [C7]. */

/** The ceiling file: every export-only file main still holds. A path may leave it; none may join. */
export const EXPORT_ONLY_CEILINGS = 'packages/gate/data/ceilings/export-only.json';

/** A cell's own front door, the one place a file of only exports belongs. */
const FRONT_DOOR = /^(?:packages|apps)\/[^/]+\/index\.js$/u;
/** An engine-floor leaf in the state cell's engines folder: one constant per file so two items adding engines never conflict [V4]. */
const ENGINE_LEAF = /^packages\/state\/src\/logic\/engines\/[a-z0-9]+(?:-[a-z0-9]+)*-engine\.js$/u;

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

/** The two door files a cell folder may hold: its light front door and its browser door. */
const DOOR_FILES = Object.freeze(['light.js', 'browser.js']);

/**
 * Every cell door that exists: each cell folder's light.js and browser.js, found from the folders themselves.
 * Why: a door is the cell's real public entry, not a shim, so the export-only rule leaves it alone; the folder shape says so without a plan read [C7].
 *
 * @param {string[]} folders - Repo-relative cell folders, such as packages/gate.
 * @param {(file: string) => boolean} exists - Whether a repo-relative file exists.
 * @returns {Set<string>} Empty when there are no folders: nothing is exempt.
 */
export function declaredDoorFiles(folders, exists) {
  const doors = new Set();
  for (const folder of folders) for (const name of DOOR_FILES) if (exists(`${folder}/${name}`)) doors.add(`${folder}/${name}`);
  return doors;
}

/**
 * One problem per changed file that is export-only, not already in the ceilings and not a declared door.
 *
 * @param {{ file: string, source: string }[]} sources - The changed files that still exist.
 * @param {string[]} allowed - The ceilings file's paths.
 * @param {Set<string>} [doors] - Cell door files found from the folders (declaredDoorFiles).
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function exportOnlyProblems(sources, allowed, doors = new Set()) {
  const known = new Set(allowed);
  return sources.filter(({ file, source }) => !known.has(file) && !doors.has(file) && exportOnly(file, source)).map(({ file }) => ({
    path: file, line: 1,
    text: `a new export-only file; export these names from the module that defines them or from the cell's index.js (${EXPORT_ONLY_CEILINGS})`,
  }));
}

/** The node:test reporters: a reporter file must default-export its generator, so these are the only plain default exports allowed [CD22]. */
export const DEFAULT_EXPORT_REPORTERS = Object.freeze([
  'packages/gate/src/io/test/action/reporter.js',
  'packages/gate/src/io/test/progress.js',
  'packages/gate/src/io/test/selection.js',
  'packages/gate/src/logic/reporter/coverage.js',
]);
/** A move module default-exports its frozen operation record, the one shape the move loader reads. */
const MOVE_MODULE = /^packages\/moves\/src\/(?:io|logic)\/moves\/[^/]+\.js$/u;
/** Tests and journeys may build default-export source as fixture text; the rule judges shipped code. */
const TEST_SOURCE = /(?:^|\/)(?:tests|journeys)\//u;

/**
 * One problem per changed source that default-exports outside the reporter list and the move modules.
 * Why: CD22 names named exports only; a default export hides its name from search and rename, so none joins unless a loader needs one.
 *
 * @param {{ file: string, source: string }[]} sources - The changed files that still exist.
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function defaultExportProblems(sources) {
  return sources.flatMap(({ file, source }) => {
    if (!/\.[cm]?js$/u.test(file) || TEST_SOURCE.test(file) || MOVE_MODULE.test(file) || DEFAULT_EXPORT_REPORTERS.includes(file)) return [];
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, match => match.replace(/[^\n]/gu, ' ')).replace(/^\s*\/\/.*$/gmu, '');
    const at = /^export\s+default\b/mu.exec(code);
    if (!at) return [];
    return [{ path: file, line: code.slice(0, at.index).split('\n').length, text: 'a default export; use a named export (CD22), or declare a reporter in DEFAULT_EXPORT_REPORTERS (packages/gate/src/logic/export/only.js)' }];
  });
}
