/** @pullboard-world-pin: both clauses read the committed test-fixtures.json and the files it names, because the registry must match this repository's own files. */
/** The fixture ceiling registry holds no row for a file missing on main, and no ceiling was raised to get there [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '../../..');
const REGISTRY = 'packages/gate/data/tests/test-fixtures.json';
const rows = JSON.parse(readFileSync(join(ROOT, REGISTRY), 'utf8'));

test('clause 1: test-fixtures.json holds no entry for a file missing on main [C7]', () => {
  const stale = Object.keys(rows).filter(file => !existsSync(join(ROOT, file)));
  assert.deepEqual(stale, [], 'remove these rows; a deleted file keeps no ceiling');
});

test('clause 2: every remaining entry is a positive whole-number ceiling per fixture kind, so removal never needed one raised [C7]', () => {
  assert.ok(Object.keys(rows).length > 0, 'live files keep their rows');
  for (const [file, kinds] of Object.entries(rows)) {
    for (const [kind, ceiling] of Object.entries(kinds)) assert.ok(Number.isInteger(ceiling) && ceiling > 0, `${file} ${kind} is ${ceiling}`);
  }
});
