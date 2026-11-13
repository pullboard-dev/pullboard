/** @pullboard-test-input apps/cli/pullboard.js */
/**
 * A new test file needs no infra note, and a gate named by a path or shell separator receives a drafted one [C7,V4].
 * Drives the real CLI in process.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  builderRepo,
  drainComparisons,
  draftedNoteCase,
  infraBox,
  put,
  submitSettled,
} from '../../tests/fixtures/submit/infra.js';

test('a new test file needs no note [C7,V4]', async (t) => {
  const box = await infraBox(t, { existing: true, files: ['test/brand-new.test.js'], edit: (box) => put(box.root, 'test/brand-new.test.js', "import '../src/a.js';\n") });
  const submitted = await submitSettled(t, box);
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  assert.doesNotMatch(`${submitted.out}\n${submitted.err}`, /INFRA_NOTE_REQUIRED/u);
  await drainComparisons(box, t);
});

test('a gate named by a quoted path receives a drafted note [C7,V4]', async (t) => {
  // The other spellings are in infra-gate-paths.test.js, split under the per-file budget.
  await draftedNoteCase(t, "node 'src/check gate.js'", 'src/check gate.js');
});
