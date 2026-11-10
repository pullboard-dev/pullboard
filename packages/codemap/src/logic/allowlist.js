/**
 * The one place that lists what may sit outside apps/ and packages/ [C7,R44]. Everything else at the root is a stray:
 * today's are a baseline that may only shrink, and a new one is refused with where it belongs.
 */

/**
 * Files allowed at the repository root: the package manifest, the board's config, the import map and the project's
 * own documents (licence, contribution, conduct and security policy, agent instructions, spec and doctrine).
 */
export const ROOT_FILES = Object.freeze(new Set([
  '.gitattributes', '.gitignore', '.npmignore', '.nvmrc',
  'AGENTS.md', 'CHANGELOG.md', 'CLA.md', 'CLAUDE.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'DOCTRINE.md', 'LICENSE',
  'README.md', 'SECURITY.md', 'SPEC.md',
  'jsconfig.json', 'package.json', 'path-map.json', 'pullboard.json',
]));

/**
 * Folders allowed at the root besides apps/ and packages/: documentation, the forge's own folder and the Git hooks the
 * checkout installs. src/ is legacy source with its own shrinking metric (legacySource) until its shims are gone.
 */
export const ROOT_FOLDERS = Object.freeze(['.githooks', '.github', 'docs', 'src']);

/**
 * Whether a repository path outside apps/ and packages/ is allowed to exist.
 *
 * @param {string} file Repository-relative path.
 * @returns {boolean}
 */
export function rootAllowed(file) {
  return ROOT_FILES.has(file) || ROOT_FOLDERS.some(folder => file.startsWith(`${folder}/`));
}

/**
 * Where a refused stray belongs, so a refusal names the next step.
 * Why: a ratchet that only says no leaves the builder to guess the cell [R44].
 *
 * @param {string} file Repository-relative path.
 * @returns {string}
 */
export function strayNextStep(file) {
  const top = file.split('/')[0];
  if (top === 'packages' || top === 'apps') return `move ${file} into its cell's index.js, src/logic/, src/io/, tests/ or data/`;
  if (top === 'test') return `put ${file} in packages/<cell>/tests/ beside the code it proves`;
  if (top === 'bin') return `put ${file}'s code in packages/<cell>/src/io/ or apps/<app>/, keeping only a thin launcher in bin/`;
  return `move ${file} under apps/<app>/ or packages/<cell>/, or, with the person's OK, add it to ROOT_FILES or ROOT_FOLDERS in packages/codemap/src/logic/allowlist.js`;
}
