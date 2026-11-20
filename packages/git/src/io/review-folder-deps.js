import {
  existsSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
} from 'node:path';

/** True when the path is the folder or inside it. */
function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The entries of one directory, or none when it is missing or unreadable. */
function entries(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The node_modules entries of a review folder whose real path lies outside it [C7,#11068].
 *
 * Walks one level, and one more under each `@scope`. Why: a symlinked dependency makes a review
 * read code that is not the commit under review, so the caller can refuse such a folder.
 *
 * @param {string} folder - The review folder.
 * @returns {string[]} Names such as `left-pad` or `@scope/pkg`, sorted; empty when all resolve inside.
 */
export function linkedDependencies(folder) {
  const root = realpathSync(folder);
  const modules = join(folder, 'node_modules');
  if (!existsSync(modules)) return [];
  const outside = [];
  const check = (name) => {
    try {
      if (!inside(root, realpathSync(join(modules, name)))) outside.push(name);
    } catch {
      outside.push(name);
    }
  };
  for (const name of entries(modules)) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      const scoped = entries(join(modules, name));
      if (scoped.length === 0) check(name);
      for (const sub of scoped) check(`${name}/${sub}`);
    } else check(name);
  }
  return outside.sort();
}
