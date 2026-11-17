/** Each test manifest row lists the spec ids its test names cite, and the freeze refuses to delete the sole proof of a claim [C7]. */
/** @pullboard-world-pin: reads the committed test manifest and the test files it lists. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { planFreeze } from '../src/io/test/freeze/plan.js';
import { testNameIds } from '../src/io/test/names.js';

const ROOT = new URL('../../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('packages/gate/data/tests/test-manifest.json', ROOT), 'utf8'));

test('gate.claim-manifest.manifest-row-lists-spec-ids: clause 1: a manifest row lists the spec ids its test names cite [C7]', () => {
  const rows = manifest.files.filter(row => row.specs.length && existsSync(new URL(row.file, ROOT)));
  assert.ok(rows.length > 100, 'many rows cite spec ids');
  for (const row of rows.slice(0, 200)) {
    for (const id of testNameIds(readFileSync(new URL(row.file, ROOT), 'utf8'))) assert.ok(row.specs.includes(id), `${row.file} lists ${id}`);
  }
});

test('gate.claim-manifest.freeze-refuses-delete-file-whose: clause 2: the freeze refuses to delete a file whose spec ids no other surviving file cites, naming them [C7]', () => {
  const row = (file, specs, extra = {}) => ({ file, kind: 'unit', specs, ...extra });
  const plan = planFreeze([
    row('a/tests/sole.test.js', ['X1', 'X2'], { tag: 'delete' }),
    row('a/tests/other.test.js', ['X1']),
    row('a/tests/also-deleted.test.js', ['X2'], { tag: 'delete' }),
    row('a/tests/dup.test.js', ['Y1'], { tag: 'delete' }),
    row('a/tests/keeps-y.test.js', ['Y1']),
  ], { owner: () => 'a' });
  const sole = plan.find(change => change.file === 'a/tests/sole.test.js');
  assert.equal(sole.action, 'refused');
  assert.match(sole.because, /X2/u);
  assert.doesNotMatch(sole.because, /X1/u);
  assert.equal(plan.find(change => change.file === 'a/tests/dup.test.js').action, 'delete');
});
