/** The one builder of the command that runs named test files, shared by submit, reuse, landing and the test pull [C7]. */

/**
 * The config's affected-tests command followed by each file as a quoted `./` path.
 *
 * Why: submit, proof reuse, landing and the deferred landing run each assembled this string by hand, and proof reuse
 * compares command strings, so one site that quoted without the `./` prefix or kept a trailing space was a silent reuse miss.
 *
 * @param {{ affectedTests: string }} config
 * @param {string[]} files - Repo-relative paths.
 * @returns {string}
 */
export function affectedCommand(config, files) {
  const word = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  return `${config.affectedTests.trimEnd()} ${files.map(file => word('./' + file)).join(' ')}`;
}
