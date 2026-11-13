import { landingWaiverProjection } from '../../../../../packages/landing/index.js';
import { landingFailureWaived } from '../../../../../packages/landing/index.js';
/** Structured native quarantine keeps actual red results and counts only executed identities [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { FILE } from '../../../tests/fixtures/cases/quarantine-verdict.js';
import { TARGET } from '../../../tests/fixtures/cases/quarantine-verdict.js';
import { runQuarantinePhases } from '../../../tests/fixtures/cases/quarantine-verdict.js';

test('native quarantine gate keeps raw red, and an uncovered sibling still blocks [C7,H16]', async t => {
  assert.deepEqual(await runQuarantinePhases(t, ['gate', 'mixed']), ['gate', 'mixed']);
});

test('quarantine continuation matches both file and name without granting a verdict [C7,H16]', () => {
  const rows = landingWaiverProjection(JSON.stringify([{ kind: 'case', test: TARGET, file: FILE }]));
  assert.equal(rows.length, 1);
  assert.equal(landingFailureWaived(rows, join(process.cwd(), FILE), TARGET), true);
  assert.equal(landingFailureWaived(rows, join(process.cwd(), 'test/another.test.js'), TARGET), false);
  assert.equal(landingFailureWaived(rows, join(process.cwd(), FILE), 'another failure [C7]'), false);
  for (const file of ['../escape.js', '/escape.js', 'test/../escape.js']) {
    assert.deepEqual(landingWaiverProjection(JSON.stringify([{ kind: 'case', test: TARGET, file }])), []);
  }
});
