/** @pullboard-test-input source-tree */
/**
 * Claim-head reads, trunk merge-base reads and branch changes made before the claim: one slice of the submit gate proof, split from gate.test.js to stay under the runner time budget [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import { selectAffectedTests } from '../../../../../packages/gate/index.js';
import { privateRepo } from '../../../tests/fixtures/submit/gate.js';
import { seedGraph } from '../../../tests/fixtures/submit/gate.js';
import { test } from 'node:test';
import { affectedSubmitModeCases } from '../../../tests/fixtures/submit/merge-base-modes.js';

test('affected selection says explicitly when no claim head was recorded [V4,C7]', async (t) => {
  const box = privateRepo(t);
  seedGraph(box);
  const selection = selectAffectedTests(box.root, { base: null, trunk: 'refs/heads/main' });
  assert.equal(selection.full, true);
  assert.match(selection.reason, /no claim head recorded/u);
});

affectedSubmitModeCases(test, ['deleted source']);
