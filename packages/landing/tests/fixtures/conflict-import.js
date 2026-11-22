/** @pullboard-world-pin walks landing caller imports to confirm the cold path stays outside the merge barrel. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../../../..');
const STATIC_IMPORT = /^\s*(?:import|export)\s[^'"`;]*?from\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gmu;

/** The files reached by static import and re-export edges from a landing entry. */
export function staticImportClosure(entry) {
  const seen = new Set();
  const stack = [resolve(REPO, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) stack.push(resolve(dirname(file), match[1] ?? match[2]));
  }
  return [...seen].map(file => relative(REPO, file));
}
