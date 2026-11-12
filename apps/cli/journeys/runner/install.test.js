/** pullboard runner install-serve copies every file the runner app imports or reads beside a module, and refuses with a code when one is missing [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serviceFiles } from '../../../../packages/runners/index.js';

test('clause 1: the install manifest is derived from the import graph, data files included, and an installed copy imports the land job modules [P7]', { timeout: 60_000 }, // budget: importing the landing and drive modules from the installed copy.
async () => {
  const install = privateFixtureFiles('pb-install-');
  const files = serviceFiles();
  assert.ok(Object.keys(files).includes('packages/gate/src/logic/refusals.json'), 'the gate refusals data file read beside a module is in the manifest');
  for (const [path, text] of Object.entries(files)) install.write(path, text);
  install.write('package.json', '{ "type": "module" }\n');
  for (const door of ['packages/landing/index.js', 'packages/drive/index.js']) {
    const loaded = await import(pathToFileURL(join(install.root, door)).href);
    assert.ok(Object.keys(loaded).length > 0, `${door} loads from the installed copy`);
  }
});

test('clause 2: a data file a module needs that is missing makes install-serve refuse with a code naming the file [P7]', () => {
  const repo = privateFixtureFiles('pb-install-root-');
  repo.write('app/entry.js', "import { readFileSync } from 'node:fs';\nexport const data = readFileSync(new URL('./gone.json', import.meta.url), 'utf8');\n");
  assert.throws(() => serviceFiles(repo.root, 'app/entry.js'), error => error.code === 'RUNNER_SERVICE_DATA' && error.message.includes('app/gone.json'));
});
