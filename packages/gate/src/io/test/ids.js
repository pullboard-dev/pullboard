/** Resolve stable test IDs to the files that carry them, and follow a move by ID so no row is keyed to a path [C7,U148]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';

const REGISTRY = /(?:^|\/)tests\/registry\.json$/u;
const TEST = /\.(?:test|spec)\.[cm]?js$/u;
const TITLE_ID = /^test\('([^':\s]+): /gmu;

/** Read tracked files either from a checkout (commit omitted) or from one commit, as one sorted path list and a reader. */
function source(root, commit) {
  if (commit) {
    const names = git(root, ['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean);
    return { names, read: name => git(root, ['show', `${commit}:${name}`], { maxBuffer: 64 * 1024 * 1024 }) };
  }
  const names = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  return { names, read: name => readFileSync(join(root, name), 'utf8') };
}

/**
 * Every stable test ID in a tree: which registry declares it, and which test file carries it now.
 * Why: the ID is the key; the path is only where the ID lives today, found by scanning the titles under the registry's own cell.
 *
 * @param {string} root A git checkout.
 * @param {string} [commit] Read this commit instead of the checkout.
 * @returns {{ byId: Map<string, string>, byFile: Map<string, string[]> }} Test file by ID, and the IDs each file carries.
 */
export function testIdIndex(root, commit) {
  const { names, read } = source(root, commit);
  const byId = new Map(), byFile = new Map();
  for (const registry of names.filter(name => REGISTRY.test(name))) {
    const cell = registry.slice(0, registry.length - '/tests/registry.json'.length);
    const declared = new Set(Object.keys(JSON.parse(read(registry))));
    for (const file of names.filter(name => TEST.test(name) && (cell === '' || name.startsWith(`${cell}/`)))) {
      for (const match of read(file).matchAll(TITLE_ID)) {
        if (!declared.has(match[1])) continue;
        byId.set(match[1], file);
        byFile.set(file, [...(byFile.get(file) ?? []), match[1]]);
      }
    }
  }
  return { byId, byFile };
}

/**
 * Give rows keyed by stable ID (items, census history, baselines) their current test file.
 * Why: a row names the ID, so a moved file changes nothing in the row; an ID no test carries is a real loss and refuses.
 *
 * @param {{ byId: Map<string, string> }} index From testIdIndex.
 * @param {Record<string, unknown>} rows Data keyed by test ID.
 * @returns {{ id: string, file: string, data: unknown }[]} One entry per row, in the rows' order.
 */
export function resolveIdRows(index, rows) {
  return Object.entries(rows).map(([id, data]) => {
    const file = index.byId.get(id);
    if (!file) throw new Refused('TEST_ID_UNKNOWN', `no test carries the ID ${id}`, 'restore the test, or retire the row keyed to this ID with the test that proved it');
    return { id, file, data };
  });
}

/**
 * The renames a move made, read from the IDs: a file that vanished and whose IDs all live in one other file now.
 * Why: this joins the path-keyed registries to the same ID, so a move still follows when Git's similarity match misses it; a split has no single new home and is left alone.
 *
 * @returns {Map<string, string>} Old path to new path.
 */
export function idRenames(before, after) {
  const renamed = new Map();
  for (const [file, ids] of before.byFile) {
    if (after.byFile.has(file)) continue;
    const homes = new Set(ids.map(id => after.byId.get(id)));
    if (homes.size === 1 && !homes.has(undefined)) renamed.set(file, [...homes][0]);
  }
  return renamed;
}
