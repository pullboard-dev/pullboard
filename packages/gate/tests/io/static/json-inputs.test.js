/** The tree registry classes list the gate data files they read, so landing.staticAffectedOnly can run only those for a changed data file [C7,#9077]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { styleSources } from '../../../../codemap/index.js';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';
import { staticClassesFor } from '../../../src/io/static/registry.js';

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));
const DATA = 'packages/gate/data';
const SOURCES = new Map(styleSources(ROOT).map(row => [row.file, row.source]));
const DATA_URL = new URL('../../../data/', import.meta.url);
const files = dataFiles();

/** The modules each tree class that reads gate data runs; a data file one of them names must be in that class's jsonInputs. */
const MODULES = {
  'test-waits': ['packages/gate/src/io/test/waits.js'],
  'cli-launches': ['packages/gate/src/io/test/launches.js'],
  'cli-child-import': ['packages/gate/src/io/test/child-fixture.js'],
  'operation-entries': ['packages/gate/src/io/static/operations.js'],
  'test-fixtures': ['packages/gate/src/io/test/fixtures.js'],
  'cells-edges': ['packages/gate/src/io/edges.js'],
  'test-cells': ['packages/gate/src/io/test/cells.js'],
  'missing-paths': ['packages/gate/src/io/paths/lint.js'],
  'worker-imports': ['packages/gate/src/io/static/worker-imports.js'],
};

/** Every .json file under the gate data folder, repo-relative. */
function dataFiles(dir = '') {
  return readdirSync(new URL(dir, DATA_URL), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? dataFiles(`${dir}${entry.name}/`) : entry.name.endsWith('.json') ? [`${DATA}/${dir}${entry.name}`] : []);
}

test('clause 2: each registry class that reads a gate data .json file declares it in jsonInputs [C7,#9077]', () => {
  for (const [name, modules] of Object.entries(MODULES)) {
    const check = STATIC_TREE_CHECKS.find(row => row.name === name);
    assert.ok(check, `${name} is a tree class`);
    const text = modules.map(file => SOURCES.get(file) ?? '').join('\n');
    assert.ok(text, `${name}: its modules are among the style sources`);
    for (const file of files.filter(row => text.includes(row.split('/').at(-1)))) {
      assert.ok(check.jsonInputs?.includes(file.split('/').at(-1).replace(/\.json$/u, '')), `${name} reads ${file} and must list it in jsonInputs`);
    }
  }
  for (const check of STATIC_TREE_CHECKS) for (const stem of check.jsonInputs ?? []) assert.ok(files.some(file => file.endsWith(`/${stem}.json`)), `${check.name} lists ${stem}, which must be a gate data file`);
});

test('clause 2: a changed gate data file runs the classes that list it and no class that reads other paths only [C7,#9077]', () => {
  const ran = staticClassesFor([`${DATA}/baselines/cli-launches.json`]).map(check => check.name);
  assert.ok(ran.includes('cli-launches'));
  assert.ok(ran.includes('layout') && ran.includes('doctrine'), 'the classes that read every path still run');
  for (const skipped of ['test-waits', 'worker-bundle', 'missing-paths', 'import-style', 'engine-folder']) assert.ok(!ran.includes(skipped), `${skipped} does not read that file`);
  assert.equal(staticClassesFor(null).length, STATIC_TREE_CHECKS.length, 'a whole run keeps every class');
});
