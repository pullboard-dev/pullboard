/** @pullboard-test-input packages/landing/src/io/land/registry-union.js */
/** unionRegistryConflict resolves a stopped merge whose only conflicts are cell test registries and touches nothing else [C7,U148]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { unionRegistryConflict } from '../../../src/io/land/registry-union.js';

const REGISTRY = 'packages/demo/tests/fixtures/registry.json';
const record = key => `  "${key}": {"proves":{"specs":["C7"],"claim":"${key}."}}`;
const registry = keys => `{\n${keys.map(record).join(',\n')}\n}\n`;

/** Commit every change under `message`. */
const commit = (root, message) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', message); };

/** A real repo where trunk and an item branch each changed the registry, then the item merge stopped; `extra` adds a source file both sides changed. */
function stopped(t, { itemText = registry(['demo.a', 'demo.c', 'demo.item']), extra = false } = {}) {
  const { root, put } = fixture(t);
  put(REGISTRY, registry(['demo.a', 'demo.c']));
  put('src/shared.txt', 'base\n');
  commit(root, 'base');
  git(root, 'checkout', '-q', '-b', 'item');
  put(REGISTRY, itemText);
  if (extra) put('src/shared.txt', 'from the item\n');
  commit(root, 'item');
  git(root, 'checkout', '-q', 'main');
  put(REGISTRY, registry(['demo.a', 'demo.c', 'demo.main']));
  if (extra) put('src/shared.txt', 'from trunk\n');
  commit(root, 'trunk');
  assert.throws(() => git(root, 'merge', '--no-ff', '-m', 'Merge item', 'item'), /CONFLICT|conflict/u, 'the merge stops on the conflict');
  return { root, conflicts: () => git(root, 'diff', '--name-only', '--diff-filter=U') };
}

test('landing.land-registry-union.two-items-adding-records-union: clause 1: two items adding different records to one cell test registry union to main\'s lines plus the item\'s new record in sorted order [C7,U148]', t => {
  const { root, conflicts } = stopped(t);
  assert.equal(conflicts(), REGISTRY);
  assert.equal(unionRegistryConflict(root), true);
  assert.equal(conflicts(), '', 'the registry is staged and nothing is left unmerged');
  const text = git(root, 'show', `:${REGISTRY}`);
  const expected = registry(['demo.a', 'demo.c', 'demo.item', 'demo.main']);
  assert.equal(text, expected.trimEnd(), 'main\'s lines are kept and the item\'s record lands in sorted order');
  assert.equal(Number(git(root, 'cat-file', '-s', `:${REGISTRY}`)), Buffer.byteLength(expected), 'the file keeps its final newline');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['demo.a', 'demo.c', 'demo.item', 'demo.main']);
});

test('landing.land-registry-union.a-source-conflict-is-not-unioned: clause 2: a stop that includes a source conflict changes nothing and returns false [C7,U148]', t => {
  const { root, conflicts } = stopped(t, { extra: true });
  const before = conflicts();
  assert.deepEqual(before.split('\n'), [REGISTRY, 'src/shared.txt']);
  assert.equal(unionRegistryConflict(root), false);
  assert.equal(conflicts(), before, 'both paths stay unmerged');
  assert.match(git(root, 'show', `:2:${REGISTRY}`), /demo\.main/u, 'the staged sides are untouched');
});

test('landing.land-registry-union.a-side-that-does-not-parse: clause 3: a registry side that does not parse as JSON changes nothing and returns false [C7,U148]', t => {
  const { root, conflicts } = stopped(t, { itemText: `{\n${record('demo.a')},\n${record('demo.item')}\n` });
  assert.equal(conflicts(), REGISTRY);
  assert.equal(unionRegistryConflict(root), false);
  assert.equal(conflicts(), REGISTRY, 'the registry stays unmerged');
});
