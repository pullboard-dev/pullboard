/** @pullboard-test-input apps/cli/pullboard.js */
/**
 * Submit asks why when a change edits an existing test or gate file [C7,V4].
 * Drives the real CLI in process.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  drainComparisons,
  infraBox,
  put,
  submitSettled,
} from '../../tests/fixtures/submit/infra.js';

test('submit drafts a note when a change edits an existing test [C7,V4]', async (t) => {
  const box = await infraBox(t, { edit: (box) => put(box.root, 'test/existing.test.js', "import '../src/a.js';\n// a reason\n") });
  const submitted = await submitSettled(t, box);
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  const shown = await box.run('show', '1');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /infra note:/u, 'the reviewer reads the drafted note in show');
  assert.match(shown.out, /test\/existing\.test\.js/u, 'show names the edited file');
  await drainComparisons(box, t);
});

test('a supplied infra note is retained and an enabled board drafts one [C7,V4]', async (t) => {
  /** Edit an existing test file after the item claim. */
  const edit = (box) => put(box.root, 'test/existing.test.js', "import '../src/a.js';\n// a change\n");
  const optional = await infraBox(t, { edit, requireInfraNote: false });
  const accepted = await submitSettled(t, optional);
  assert.equal(accepted.code, 0, `${accepted.out}\n${accepted.err}`);
  assert.doesNotMatch(`${accepted.out}\n${accepted.err}`, /INFRA_NOTE_REQUIRED/u);

  const recorded = await infraBox(t, { edit, requireInfraNote: false });
  const noted = await submitSettled(t, recorded, '--infra', 'the change keeps the real listener covered');
  assert.equal(noted.code, 0, `${noted.out}\n${noted.err}`);
  const shown = await recorded.run('show', '1');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /infra note: the change keeps the real listener covered/u);
  assert.match(shown.out, /test\/existing\.test\.js/u);

  const enabled = await infraBox(t, { edit, requireInfraNote: true });
  const drafted = await submitSettled(t, enabled);
  assert.equal(drafted.code, 0, `${drafted.out}\n${drafted.err}`);
  assert.match((await enabled.run('show', '1')).out, /infra note:/u);
  for (const box of [optional, recorded, enabled]) await drainComparisons(box, t);
});
