/** @pullboard-test-input source-cell gate */
/** The fixture scan treats the git cell's child fixture as part of the kit, so its one mkdtempSync is no tempdir site [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureSites } from '../../../src/io/test/fixtures.js';

const SOURCE = "import { mkdtempSync } from 'node:fs';\nexport const make = () => mkdtempSync('x-');\n";

test('gate.io-test-fixtures.git-child-is-kit: clause 1: fixtureSites returns no tempdir site for a mkdtempSync source at the git child fixture path and still reports one at another path [C7]', () => {
  assert.deepEqual(fixtureSites(SOURCE, 'packages/git/tests/fixtures/child.js'), []);
  const other = fixtureSites(SOURCE, 'packages/git/tests/fixtures/other.js');
  assert.equal(other.length, 1);
  assert.equal(other[0].kind, 'tempdir');
});
