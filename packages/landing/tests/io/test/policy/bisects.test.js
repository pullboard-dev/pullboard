/** A failing test file that base main does not have is the batch's own red, so bisect blames its item [C7,#2947]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { splitBaseRed } from '../../../../src/io/step/diagnose.js';

/** A real repository whose base commit has one existing test file. */
function base(t) {
  const root = mkdtempSync(join(tmpdir(), 'pb-new-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'old.test.js'), '// exists on base\n');
  git('add', '-A');
  spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base'], { cwd: root });
  return { root, head: git('rev-parse', 'HEAD') };
}

test('landing.bisects.a-failure-in-a-file-absent: a failure in a file absent on base is the batch\'s own, with no base comparison asked [C7,#2947]', async t => {
  const { root, head } = base(t);
  const state = { batch: { root, base: head } };
  const failure = { file: 'new.test.js', name: 'the new case' };
  const split = await splitBaseRed(state, [failure], async () => assert.fail('a file main does not have needs no comparison'));
  assert.deepEqual(split, { known: [], own: [failure] });
});

test('landing.bisects.a-file-present-on-base-whose: a file present on base whose comparison is unavailable still holds the batch [C7,#2947]', async t => {
  const { root, head } = base(t);
  const state = { batch: { root, base: head } };
  const split = await splitBaseRed(state, [{ file: 'old.test.js', name: 'case' }], async () => ({ main: head, files: [], unavailable: 'runner unavailable' }));
  assert.equal(split, null);
});
