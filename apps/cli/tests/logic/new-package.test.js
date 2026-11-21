/** A new package's files come from one pure function that writes nothing [C7,#11083]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newPackageFiles } from '../../src/logic/new-package.js';

test('cli.logic-new-package.anatomy-paths: clause 1: [C7] newPackageFiles(name, purpose) returns the cell anatomy under packages/<name> and the front door opens with the purpose', () => {
  const files = newPackageFiles('my-cell', 'Counts widgets for the shop');
  assert.deepEqual(Object.keys(files).sort(), [
    'packages/my-cell/index.js',
    'packages/my-cell/light.js',
    'packages/my-cell/tests/fixtures/registry.json',
    'packages/my-cell/tests/inputs.test.js',
    'packages/my-cell/tests/registry.test.js',
  ]);
  assert.equal(files['packages/my-cell/index.js'].split('\n')[0], '/** Counts widgets for the shop [C7] */');
  assert.equal(files['packages/my-cell/light.js'].split('\n')[0], '/** Counts widgets for the shop [C7] */');
  for (const text of Object.values(files)) assert.ok(!text.includes('{{'), 'every placeholder is filled');
  assert.ok(files['packages/my-cell/tests/registry.test.js'].includes("'my-cell.registry.complete: "));
  assert.deepEqual(Object.keys(JSON.parse(files['packages/my-cell/tests/fixtures/registry.json'])), ['my-cell.registry.complete', 'my-cell.inputs.declared']);
});

test('cli.logic-new-package.refuses-non-kebab: clause 2: [C7] newPackageFiles refuses a name that is not lowercase kebab-case', () => {
  for (const bad of ['MyCell', 'my_cell', 'my cell', '-lead', 'trail-', 'a--b', '', '9lives', '../up']) {
    assert.throws(() => newPackageFiles(bad, 'a purpose'), { code: 'USAGE' }, `refuses ${JSON.stringify(bad)}`);
  }
  assert.throws(() => newPackageFiles('ok-name', ''), { code: 'USAGE' });
});
