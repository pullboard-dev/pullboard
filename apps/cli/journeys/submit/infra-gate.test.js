/** @pullboard-test-input apps/cli/pullboard.js */
/**
 * A new test file needs no infra note, and a gate named by a path or shell separator receives a drafted one [C7,V4].
 * Drives the real CLI in process.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  builderRepo,
  commitAll,
  drainComparisons,
  infraBox,
  privateRepo,
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

test('a gate named by a quoted path or a shell separator receives a drafted note [C7,V4]', async (t) => {
  // Each gate names a script the change then edits: a quoted path with a space, and a path followed by a separator.
  // An unnormalized path names the same file Git reports, so it needs the note too (#814 review).
  for (const [gate, file] of [["node 'src/check gate.js'", 'src/check gate.js'], ['node src/check.js; true', 'src/check.js'],
    ['node src/../src/check.js', 'src/check.js'], ['node ./src/./check.js', 'src/check.js']]) {
    let box = await privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate, spec: 'SPEC.md' }));
    put(box.root, file, 'process.exit(0);\n');
    commitAll(box);
    box = await builderRepo(box, { extraOwns: ['gate.js'] });
    const added = await box.coordinator('add', 'build', 'Gate named by a path', '--criterion', 'the submit handles the changed gate path',
      '--check', 'true', '--route', 'strong', '--brief', `Files:\n- ${file}\nChange: exercise infrastructure-note handling for the gate path.\nTest: verify the note behavior for the changed file.\nOut of scope: product behavior.`);
    assert.equal(added.code, 0, `${added.out}\n${added.err}`);
    assert.equal((await box.run('claim', '1')).code, 0);
    put(box.root, file, 'process.exit(0); // edited after the claim\n');
    commitAll(box, 'feat(core): change the gate script [G1]');
    const submitted = await submitSettled(t, box);
    assert.equal(submitted.code, 0, `${gate}: ${submitted.out}\n${submitted.err}`);
    const shown = await box.run('show', '1');
    assert.match(shown.out, /infra note:/u);
    assert.ok(shown.out.includes(file), `${gate}: the note names ${file}`);
    await drainComparisons(box, t);
  }
});
