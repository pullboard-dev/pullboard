/** Where the shipped source lives, for tests that scan it: every cell and app `src` folder [V32]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';

/** The repository root: this fixture sits at apps/cli/tests/fixtures. */
export const REPOSITORY = resolve(import.meta.dirname, '../../../..');

/**
 * Every source folder under apps/ and packages/, relative to the repository, sorted.
 * Why: the old single src/ folder is now spread over the cells and apps.
 *
 * @param {string} [repository]
 * @returns {string[]}
 */
export function sourceFolders(repository = REPOSITORY) {
  return ['apps', 'packages']
    .flatMap((group) => readdirSync(join(repository, group)).sort().map((name) => `${group}/${name}/src`))
    .filter((folder) => existsSync(join(repository, folder)));
}

/**
 * Every shipped `.js` source file, relative to the repository with `/` separators, sorted.
 *
 * @param {string} [repository]
 * @returns {string[]}
 */
export function sourceFiles(repository = REPOSITORY) {
  return sourceFolders(repository).flatMap((folder) => readdirSync(join(repository, folder), { recursive: true })
    .filter((file) => typeof file === 'string' && file.endsWith('.js'))
    .map((file) => `${folder}/${file.split('\\').join('/')}`)).sort();
}

/**
 * Where the `.js` files the old top-level src/ folder held live now, relative to the repository, sorted: the targets of
 * the layout move's rename table for every `src/*.js` row it moved (a deleted shim has no target).
 * Why: a scan of src/ meant that file set; it is spread over the cells and apps now, and only the table says which files.
 *
 * @param {string} [repository]
 * @returns {string[]}
 */
export function movedSourceFiles(repository = REPOSITORY) {
  const table = readFileSync(join(repository, 'packages/codemap/data/plan/renames.tsv'), 'utf8');
  return [...new Set(table.split('\n').map((row) => row.split('\t'))
    .filter(([from, to]) => from.startsWith('src/') && from.endsWith('.js') && to?.endsWith('.js'))
    .map(([, to]) => to)
    .filter((to) => existsSync(join(repository, to))))].sort();
}
