/** The dirty-warning observer covers apps/lib/src shipped runtime on a controlled clock [O5,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeDirtyRunnerTooling } from '../../../packages/runners/index.js';
import { cellSandbox } from '../../../packages/store/tests/fixtures/cell.js';

test('lib.tooling.a-dirty-apps-lib-src-edit-warns: a dirty apps/lib/src edit warns and an unrelated path does not [O5,C7]', t => {
  const box = cellSandbox(t), root = join(box.dir, 'tooling');
  mkdirSync(join(root, 'apps/lib/src'), { recursive: true });
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'apps/lib/src/runtime.js'), '// shipped\n');
  writeFileSync(join(root, 'docs/note.md'), 'note\n');
  box.git(root, 'init', '-q', '-b', 'main');
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'test: baseline');
  writeFileSync(join(root, 'apps/lib/src/runtime.js'), '// shipped\n// dirty\n');
  writeFileSync(join(root, 'docs/note.md'), 'note\nchanged\n');
  const editedAt = Date.now();
  assert.deepEqual(observeDirtyRunnerTooling(new Date(editedAt), [], root), [], 'a fresh edit stays inside the five minute window');
  const findings = observeDirtyRunnerTooling(new Date(editedAt + 300_001), [], root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /apps\/lib\/src\/runtime\.js/u);
  assert.ok(findings.every(row => !row.title.includes('docs/note.md')), 'an unrelated path is not observed');
});
