/** @pullboard-test-input source-cell packages/api */
/** The API package's tests take the fixture kit from package homes, never from the CLI's fixture folder [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';

const TESTS = import.meta.dirname;
const REPO = join(TESTS, '../../..');
const KIT = join(REPO, 'apps', 'cli', 'tests', 'fixtures');

/** Every .js file under a folder, recursively. */
function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? testFiles(path) : entry.name.endsWith('.js') ? [path] : [];
  });
}

test('api.kit-home.no-cli-fixture-import: clause 1: no test file under packages/api/tests imports a module of the CLI fixture kit [C7]', () => {
  const offenders = [];
  for (const file of testFiles(TESTS)) {
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/gu)) {
      const target = resolve(dirname(file), specifier);
      if (target.startsWith(KIT)) offenders.push(`${relative(REPO, file)} imports ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});
