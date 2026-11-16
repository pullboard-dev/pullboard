/** @pullboard-test-input source-cell apps/cli packages/items packages/stats packages/queue */
/**
 * pullboard status reaches the items, stats and queue cells only through their light doors, so no heavy barrel loads for the few names it prints [C7,#8646].
 * Why static: the modules a command loads are the ones its import statements name, so no process is launched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../../../../../..');
const STATUS = readFileSync(resolve(REPO, 'apps/cli/src/io/commands/status.js'), 'utf8');
const NAMES = {
  items: ['localDependencyIds', 'dependencyLabel', 'itemFileCollisions', 'foreignBlockers'],
  stats: ['readCapacity', 'capacityLines'],
  queue: ['routingCapacity'],
};

/** The module path each top-level static import of status.js names, keyed by imported name; multi-line lists count. */
function importedFrom() {
  const found = new Map();
  for (const match of STATUS.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)'/gmu)) {
    for (const name of match[1].split(',').map(part => part.trim().split(/\s+as\s+/u)[0]).filter(Boolean)) found.set(name, match[2]);
  }
  return found;
}

test('clause 1: status imports every items, stats and queue name through that package light door [C7]', () => {
  const from = importedFrom();
  for (const [pkg, names] of Object.entries(NAMES)) {
    for (const name of names) assert.ok(from.get(name)?.endsWith(`/packages/${pkg}/light.js`), `${name} comes from ${from.get(name)}, not packages/${pkg}/light.js`);
  }
});

test('clause 1: each light door exports the names status takes from it [C7]', () => {
  for (const pkg of Object.keys(NAMES)) {
    const door = readFileSync(resolve(REPO, `packages/${pkg}/light.js`), 'utf8');
    for (const name of NAMES[pkg]) assert.match(door, new RegExp(`\\b${name}\\b`, 'u'), `packages/${pkg}/light.js does not export ${name}`);
  }
});

test('clause 1: status keeps no stats or queue barrel import and no items barrel import of these names [C7]', () => {
  assert.doesNotMatch(STATUS, /packages\/(?:stats|queue)\/index\.js/u);
  for (const match of STATUS.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'[^']*packages\/items\/index\.js'/gmu)) {
    for (const name of NAMES.items) assert.doesNotMatch(match[1], new RegExp(`\\b${name}\\b`, 'u'));
  }
});
