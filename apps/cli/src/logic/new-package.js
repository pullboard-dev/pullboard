import { Refused } from '../../../../packages/kernel/index.js';
import anatomy from './new-package.json' with { type: 'json' };

/** The cell name a new package may take: lowercase words joined by single hyphens. */
const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/**
 * The files of a new package cell as { path: text }, every path under packages/<name>/; the front door opens with a one-line doc comment carrying the purpose. Writes nothing.
 * The starter files and their text come from new-package.json, so this code names no test file [C7,#11083].
 * @param {string} name the cell's folder name, lowercase kebab-case
 * @param {string} purpose one line saying what the cell is for
 * @returns {Record<string, string>}
 */
export function newPackageFiles(name, purpose) {
  if (typeof name !== 'string' || !KEBAB.test(name)) throw new Refused('USAGE', 'name a new package in lowercase kebab-case, such as pullboard new package my-cell "what it is for"');
  if (typeof purpose !== 'string' || purpose.trim() === '' || /[\r\n]/u.test(purpose)) throw new Refused('USAGE', 'give the purpose as one non-empty line');
  const fill = (text) => text.replaceAll('{{name}}', name).replaceAll('{{purpose}}', purpose.trim());
  return Object.fromEntries(anatomy.files.map(({ path, text }) => [`packages/${name}/${path}`, fill(text)]));
}
