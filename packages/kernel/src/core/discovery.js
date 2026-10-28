/**
 * Which files are commands and which are engines, in one place [C7,V4]. The runtime discovery in src/commands/index.js and
 * src/machine.js and the affected-test selector in src/affected-tests.js all read these, so no name is accepted by one and
 * missed by another. A candidate is any file that looks like one; a name with a character outside the strict set is refused
 * at discovery with a clear error, and the selector still treats it as reaching its reader.
 */

/** Every file in src/commands/ other than the registry is a command candidate. */
export const COMMAND_CANDIDATE = /^(?!index\.js$)[^/]+\.js$/u;

/** A command file name the registry accepts: letters, digits, underscores and hyphens. */
export const COMMAND_FILE = /^[\w-]+\.js$/u;

/** Every file in src/ ending in -engine.js is an engine candidate. */
export const ENGINE_CANDIDATE = /^[^/]*-engine\.js$/u;

/** An engine file name machine.js accepts: letters, digits, underscores and hyphens before -engine.js. */
export const ENGINE_FILE = /^[\w-]+-engine\.js$/u;

/** Every JavaScript file in src/moves/ declares one board operation. */
export const MOVE_CANDIDATE = /^[^/]+\.js$/u;

/** Operation file names follow the same strict spelling as discovered commands. */
export const MOVE_FILE = /^[\w-]+\.js$/u;

/**
 * Keep the candidates of a folder that the strict pattern accepts, refusing the rest by name.
 *
 * @param {string[]} names file names in the folder
 * @param {RegExp} candidate what looks like a member
 * @param {RegExp} strict what a member may be called
 * @param {string} what what the members are, for the error
 * @returns {string[]} the accepted names, sorted
 */
export function discovered(names, candidate, strict, what) {
  const found = names.filter((name) => candidate.test(name)).sort();
  const refused = found.filter((name) => !strict.test(name));
  if (refused.length) throw new Error(`${refused.join(', ')} cannot be a ${what}: use only letters, digits, underscores and hyphens in the file name`);
  return found;
}
