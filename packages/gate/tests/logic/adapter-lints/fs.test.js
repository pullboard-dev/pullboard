/** @pullboard-test-input source-cell gate */
/** The file-system lint names a direct node:fs import outside the kernel and holds today's offenders at a ceiling [C7,#9449]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../fixtures/child.js';
import {
  coveredByFsLint,
  FS_CEILING_FILE,
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

test('gate.logic-adapter-lints-fs.generated-probe-script-is-exempt: clause 2: the runner probe, whose node:fs import sits in a script text sent to the runner, is exempt by exact path and a same-named file elsewhere is not [C7,#11632]', () => {
  const text = "const script = `const fs=require('node:fs');`;\n";
  const root = repo({ 'packages/runners/src/io/probe.js': text, 'packages/runners/src/io/package/install.js': text, 'packages/other/src/io/probe.js': text });
  assert.deepEqual(fsLintRows(root, { enabled: true }).map(row => row.split(':')[0]), ['packages/other/src/io/probe.js']);
});

test('gate.logic-adapter-lints-fs.generated-child-scripts-are-exempt: clause 1: the two submit files holding generated child scripts are exempt by exact path and a sibling is not [C7,#11931]', () => {
  assert.equal(coveredByFsLint('apps/cli/src/io/submit/pull.js'), false);
  assert.equal(coveredByFsLint('apps/cli/src/io/submit/remote.js'), false);
  assert.equal(coveredByFsLint('apps/cli/src/io/submit/gate.js'), true);
  const text = Array.from({ length: 7 }, (_, i) => `import { f${i} } from 'node:fs';`).join('\n');
  assert.deepEqual(fsFindings({ 'apps/cli/src/io/submit/pull.js': text }, {}), []);
  assert.equal(fsFindings({ 'apps/cli/src/io/submit/gate.js': text }, {}).length, 7);
});

test('gate.logic-adapter-lints-fs.real-tree-generated-child-scripts: clause 3: the real-path lint over this checkout names neither exempt file [C7,#11931]', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const rows = fsLintRows(root, { enabled: true });
  assert.equal(rows.some(row => row.startsWith('apps/cli/src/io/submit/pull.js:') || row.startsWith('apps/cli/src/io/submit/remote.js:')), false);
});
