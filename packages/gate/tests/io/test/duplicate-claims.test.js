/** @pullboard-test-input packages/receipt/tests/registry.json */
/** Two registered tests that prove the same claim are flagged by ID, and the receipt cell's own records pass [C7,U148]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { duplicateClaims } from '../../../index.js';
import { requireUniqueClaims } from '../../../index.js';

const RECEIPT = fileURLToPath(new URL('../../../../receipt/tests/registry.json', import.meta.url));
const record = claim => ({ proves: { specs: ['C7'], claim }, why: 'w', kind: 'cell unit', inputs: ['x'] });

test('duplicate.claims.flag: [C7] two records with the same claim fail the check, naming both IDs and the next step', t => {
  const { root: dir } = privateFixtureFiles('dup-claims-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'registry.json');
  writeFileSync(file, JSON.stringify({
    'cell.b.same': record('a key is stable per candidate.'),
    'cell.a.same': record('A key  is stable per Candidate'),
    'cell.c.other': record('a different claim'),
  }));
  assert.deepEqual(duplicateClaims(JSON.parse(JSON.stringify({ x: record('one'), y: record('two') }))), []);
  assert.throws(() => requireUniqueClaims(file), error => error.code === 'DUPLICATE_TEST_CLAIM'
    && error.message.includes('cell.a.same') && error.message.includes('cell.b.same') && !error.message.includes('cell.c.other')
    && /merge|retire/u.test(error.next ?? ''));
});

test('duplicate.claims.receipt: [C7] the receipt cell records carry no shared claim', () => {
  assert.deepEqual(duplicateClaims(JSON.parse(readFileSync(RECEIPT, 'utf8'))), []);
  assert.doesNotThrow(() => requireUniqueClaims(RECEIPT));
});
