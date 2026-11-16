/** Every JSON_SHAPES.commands key has a catalog case that names it, checked without spawning the CLI [A1,C7,#8843]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { catalogCases } from '../../../tests/fixtures/catalog/cases.js';

test('clause 1: every catalog case names the JSON_SHAPES.commands keys it covers [A1,C7]', () => {
  assert.ok(catalogCases.length > 0, 'cases.js registers its cases');
  for (const { name, covers } of catalogCases) {
    assert.ok(Array.isArray(covers), `case "${name}" names the keys it covers`);
    for (const key of covers) assert.ok(JSON_SHAPES.commands[key], `case "${name}" names "${key}", which JSON_SHAPES.commands does not document`);
  }
});

test('clause 2: every JSON_SHAPES.commands key has a catalog case [A1,C7]', () => {
  const named = new Set(catalogCases.flatMap(({ covers }) => covers));
  const missing = Object.keys(JSON_SHAPES.commands).filter((key) => !named.has(key));
  assert.deepEqual(missing, [], `add or extend a case in cases.js for: ${missing.join(', ')}`);
});
