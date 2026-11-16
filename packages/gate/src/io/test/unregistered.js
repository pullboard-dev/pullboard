/** The static finding for test files a change adds without a registry record or a golden user path [C7,U148,#9402]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compositionBase } from './fixtures.js';
import { GOLDEN_FILE } from './manifest.js';
import { unregisteredNewTests } from '../../logic/test-registry.js';

const CELL_REGISTRY = /^((?:packages|apps)\/[^/]+)\/tests\/registry\.json$/u;

/** The test files the branch added since it met main (a modified test file is never listed), or none when no base is known. */
function addedPaths(root, base) {
  if (!base) return [];
  const run = spawnSync('git', ['diff', '--name-only', '--diff-filter=A', `${base}`, 'HEAD', '--', '*.js'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return run.status === 0 ? run.stdout.split('\n').filter(Boolean) : [];
}

/** Every cell folder holding a tests registry, and the IDs those registries record. */
function registries(root) {
  const cells = [], records = {};
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const name of listed.status === 0 ? listed.stdout.split('\0') : []) {
    const found = CELL_REGISTRY.exec(name);
    if (!found) continue;
    cells.push(found[1]);
    try { Object.assign(records, JSON.parse(readFileSync(join(root, name), 'utf8'))); } catch { /* A broken registry is another check's finding; its IDs count as unknown here. */ }
  }
  return { cells, records };
}

/** The golden user paths, or none when the file is missing or unreadable. */
function goldenPaths(root) {
  try { return JSON.parse(readFileSync(join(root, GOLDEN_FILE), 'utf8')).paths ?? []; } catch { return []; }
}

/**
 * One row per finding for the test files this change adds, each leading with the rule code TEST_UNREGISTERED and ending
 * with the one next step. Only added files are judged, so editing an existing test never trips it. Why: a registry that
 * only describes tests already written does not stop new ones arriving without an ID [C7,U148].
 *
 * @param {string} root checkout root
 * @param {{ base?: string | null, only?: string[] | null }} [options] the composition base and the changed paths, when known
 * @returns {string[]} `path: TEST_UNREGISTERED (code): message; next: step` rows
 */
export function unregisteredTestRows(root, { base = compositionBase(root), only = null } = {}) {
  const added = addedPaths(root, base).filter(path => !only || only.includes(path));
  if (!added.length) return [];
  const { cells, records } = registries(root);
  const files = added.map(path => ({ path, text: readFileSync(join(root, path), 'utf8') }));
  return unregisteredNewTests({ added: files, registeredCells: cells, records, golden: goldenPaths(root) })
    .map(found => `${found.file}: TEST_UNREGISTERED (${found.code}): ${found.message}; next: ${found.next}`);
}
