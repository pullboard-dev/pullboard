/** Every JSON_SHAPES.commands key has a catalog case that names it, checked without spawning the CLI [A1,C7,#8843]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { resultCommands } from '../../../index.js';
import { addRoot } from '../../../tests/fixtures/catalog/cases.js';
import { catalogCases } from '../../../tests/fixtures/catalog/cases.js';
import { catalogGroups } from '../../../tests/fixtures/catalog/cases.js';
import { coveredRoots } from '../../../tests/fixtures/catalog/cases.js';
import { declaredRun } from '../../../tests/fixtures/catalog/cases.js';

test('catalog keys: every catalog case names the JSON_SHAPES.commands keys it covers [A1,C7]', () => {
  assert.ok(catalogCases.length > 0, 'cases.js registers its cases');
  for (const { name, covers } of catalogCases) {
    assert.ok(Array.isArray(covers), `case "${name}" names the keys it covers`);
    for (const key of covers) assert.ok(JSON_SHAPES.commands[key], `case "${name}" names "${key}", which JSON_SHAPES.commands does not document`);
  }
});

test('catalog keys: every JSON_SHAPES.commands key has a catalog case [A1,C7]', () => {
  const named = new Set(catalogCases.flatMap(({ covers }) => covers));
  const missing = Object.keys(JSON_SHAPES.commands).filter((key) => !named.has(key));
  assert.deepEqual(missing, [], `add or extend a case in cases.js for: ${missing.join(', ')}`);
});

test('clause 1: the union of every catalog case\'s declared roots equals resultCommands() without running a case [A1,C7]', () => {
  for (const { name, roots } of catalogCases) assert.ok(Array.isArray(roots), `case "${name}" declares the root commands its run adds`);
  const declared = [...new Set(catalogCases.flatMap(({ roots }) => roots))].sort();
  const wanted = resultCommands();
  const missing = wanted.filter((root) => !declared.includes(root));
  const unknown = declared.filter((root) => !wanted.includes(root));
  assert.deepEqual({ missing, unknown }, { missing: [], unknown: [] }, 'every result-producing root is declared by some catalog case, and no case declares an unknown root');
  assert.deepEqual(declared, wanted);
});

test('clause 2: a catalog case fails if it adds a root it did not declare [A1,C7]', async () => {
  const probe = 'undeclared-root-probe';
  try {
    await declaredRun(['init'], async () => { addRoot('init'); })();
    await assert.rejects(declaredRun(['init'], async () => { addRoot('init'); addRoot(probe); }), new RegExp(probe, 'u'));
  } finally { coveredRoots.delete(probe); }
});

test('clause 1: every catalog case appears in exactly one of the six groups exported from cases.js [A1,C7,#9675]', () => {
  assert.deepEqual(Object.keys(catalogGroups).sort(), ['commands', 'exercises', 'lanes', 'results', 'results-a1', 'results-a2'], 'six groups, one per run file');
  const grouped = Object.values(catalogGroups).flat().map(({ name }) => name);
  assert.deepEqual([...grouped].sort(), catalogCases.map(({ name }) => name).sort(), 'the groups hold every case once and nothing else');
  assert.equal(new Set(grouped).size, grouped.length, 'no case sits in two groups');
});

test('clause 1: no catalog case name repeats, so a group lists each case by name unambiguously [A1,C7,#9675]', () => {
  const names = catalogCases.map(({ name }) => name);
  assert.equal(new Set(names).size, names.length);
});
