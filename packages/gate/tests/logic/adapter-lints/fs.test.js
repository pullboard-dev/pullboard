/** @pullboard-test-input source-cell gate */
/** The file-system lint names a direct node:fs import outside the kernel and holds today's offenders at a ceiling [C7,#9449]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import {
  FS_CEILING_FILE,
  coveredByFsLint,
  fsFindings,
  fsLintRows,
} from '../../../src/io/adapter-lints/fs.js';

/** A scratch repo holding `files`, with an optional ceilings file. */
function repo(files, ceilings) {
  const tree = privateFixtureFiles('pb-fslint-');
  for (const [path, text] of Object.entries(files)) tree.write(path, text);
  if (ceilings) tree.write(FS_CEILING_FILE, JSON.stringify({ version: 1, files: ceilings }));
  return tree.root;
}

test('gate.logic-adapter-lints-fs.with-the-setting-on-a-file: clause 1: with the setting on, a file outside the kernel importing node:fs fails naming file, line and adapter [C7,#9449]', () => {
  const root = repo({
    'packages/a/src/x.js': "export const a = 1;\nimport { readFileSync } from 'node:fs';\nimport { stat } from 'node:fs/promises';\n",
    'packages/kernel/src/logic/disk.js': "import { readFileSync } from 'node:fs';\n",
  });
  const rows = fsLintRows(root, { enabled: true });
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^packages\/a\/src\/x\.js:2: from 'node:fs' read directly outside the kernel/u);
  assert.match(rows[1], /^packages\/a\/src\/x\.js:3: from 'node:fs\/promises' read directly/u);
  assert.ok(rows.every(row => row.includes('use the file-system adapter in packages/kernel')));
  assert.ok(rows.every(row => !row.includes('packages/kernel/src')), 'the kernel folder is exempt');
});

test('gate.logic-adapter-lints-fs.comments-tests-and-other-modules-are: clause 1: comments, tests and other modules are not direct imports [C7,#9449]', () => {
  const root = repo({
    'packages/a/src/x.js': "// import { a } from 'node:fs';\nimport { join } from 'node:path';\nconst fsx = 'node:fsx';\n",
    'packages/a/tests/x.test.js': "import { readFileSync } from 'node:fs';\n",
  });
  assert.deepEqual(fsLintRows(root, { enabled: true }), []);
});

test('gate.logic-adapter-lints-fs.offenders-at-their-ceiling-pass-and: clause 2: offenders at their ceiling pass and a new import in the same file fails; the ceiling never rises [C7,#9449]', () => {
  const files = { 'packages/a/src/x.js': "import a from 'node:fs';\nimport b from 'node:fs/promises';\n", 'packages/b/src/y.js': "import a from 'node:fs';\n" };
  const root = repo(files, { 'packages/a/src/x.js': 2 });
  const rows = fsLintRows(root, { enabled: true });
  assert.deepEqual(rows.map(row => row.split(':')[0]), ['packages/b/src/y.js'], 'a file past its ceiling (zero for an unlisted file) fails');
  const grown = repo({ 'packages/a/src/x.js': "import a from 'node:fs';\nimport b from 'node:fs/promises';\nimport c from 'fs';\n" }, { 'packages/a/src/x.js': 2 });
  assert.equal(fsLintRows(grown, { enabled: true }).length, 3);
});

test('gate.logic-adapter-lints-fs.with-the-setting-off-which-is: clause 2: with the setting off, which is the default, the lint reports nothing [C7,#9449]', () => {
  const root = repo({ 'packages/a/src/x.js': "import a from 'node:fs';\n" });
  assert.deepEqual(fsLintRows(root), []);
  assert.deepEqual(fsLintRows(root, { enabled: false }), []);
  assert.deepEqual(fsLintRows(root, { enabled: 'yes' }), []);
});

const GENERATED_CHILD = 'packages/runners/src/io/service.js';

test('gate.logic-adapter-lints-fs.generated-child-is-exempt: clause 1: the runner service installer is exempt by exact path, a sibling file is not, and its program text reports nothing [C7,#11636]', () => {
  assert.equal(coveredByFsLint(GENERATED_CHILD), false);
  assert.equal(coveredByFsLint('packages/runners/src/io/slots.js'), true);
  const text = "const program = [\n  \"import { rmSync } from 'node:fs';\",\n];\n";
  assert.deepEqual(fsFindings({ [GENERATED_CHILD]: text }), []);
  assert.equal(fsFindings({ 'packages/runners/src/io/slots.js': text }).length, 1);
});

test('gate.logic-adapter-lints-fs.real-tree-generated-child: clause 2: the lint over this checkout with the setting on returns no row naming the runner service installer or slots [C7,#11636]', () => {
  const rows = fsLintRows(join(import.meta.dirname, '..', '..', '..', '..', '..'), { enabled: true });
  assert.deepEqual(rows.filter(row => row.startsWith(`${GENERATED_CHILD}:`) || row.startsWith('packages/runners/src/io/slots.js:')), []);
});
