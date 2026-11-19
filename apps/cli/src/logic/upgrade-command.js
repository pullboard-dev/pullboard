/** The upgrade command for one install kind, pure: the caller reads the package name and runs nothing here [C7,#1303]. */
import { Refused } from '../../../../packages/kernel/index.js';

/** One upgrade command per install kind the update command can tell apart. */
const UPGRADE = Object.freeze({
  global: name => `npm install -g ${name}@latest`,
  npx: name => `npx --yes ${name}@latest --version`,
  project: name => `npm install --save-dev ${name}@latest`,
});

/**
 * The shell command that upgrades Pullboard the way it was installed: `{ command }` for a known kind,
 * `{ refusal }` naming the one manual command for an unknown kind, so nothing guesses a way to upgrade [C7].
 *
 * @param {string} kind global, npx, project, or anything else for an install nobody could classify
 * @param {string} name the package name, read from the root package.json name field by the caller
 */
export function upgradeCommand(kind, name) {
  if (typeof name !== 'string' || name === '') throw new TypeError('upgradeCommand needs the package name');
  const build = Object.hasOwn(UPGRADE, kind) ? UPGRADE[kind] : null;
  if (build) return { command: build(name) };
  return { refusal: new Refused('UPDATE_KIND_UNKNOWN', `could not tell how ${name} was installed; upgrade it yourself with ${UPGRADE.global(name)}`) };
}
