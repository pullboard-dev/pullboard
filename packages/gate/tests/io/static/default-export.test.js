/** A new default export outside the declared reporter list and the move modules is refused [CD22]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_EXPORT_REPORTERS } from '../../../src/logic/export/only.js';
import { defaultExportProblems } from '../../../src/logic/export/only.js';
import { STATIC_CHECKS } from '../../../src/io/static/check/registry.js';

test('gate.io-static-default-export.a-new-default-export-in-shipped: a new default export in shipped code is refused, naming its line [CD22]', () => {
  const rows = defaultExportProblems([{ file: 'packages/a/src/io/x.js', source: "/** Why. */\nconst x = 1;\nexport default x;\n" }]);
  assert.deepEqual(rows.map(row => [row.path, row.line]), [['packages/a/src/io/x.js', 3]]);
  assert.match(rows[0].text, /DEFAULT_EXPORT_REPORTERS/u);
});

test('gate.io-static-default-export.declared-reporters-and-move-modules-pass: declared reporters and move modules pass; tests, comments and named exports are not judged [CD22]', () => {
  const source = 'export default async function* report(events) {}\n';
  assert.deepEqual(defaultExportProblems(DEFAULT_EXPORT_REPORTERS.map(file => ({ file, source }))), []);
  assert.deepEqual(defaultExportProblems([{ file: 'packages/moves/src/logic/moves/addItem.js', source: 'export default Object.freeze({});\n' }]), []);
  assert.deepEqual(defaultExportProblems([{ file: 'packages/a/tests/x.test.js', source }, { file: 'apps/cli/journeys/a/b.test.js', source }]), []);
  assert.deepEqual(defaultExportProblems([{ file: 'packages/a/src/x.js', source: '// export default x;\n/*\nexport default y;\n*/\nexport const z = 1;\n' }]), []);
});

test('gate.io-static-default-export.submit-judges-default-exports-through-the: submit judges default exports through the static check list [CD22]', () => {
  assert.ok(STATIC_CHECKS.some(check => check.name === 'default-export'));
});
