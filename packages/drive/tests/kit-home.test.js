/** @pullboard-test-input source-cell packages/drive */
/** No drive test imports a module of the CLI fixture kit: they take their helpers from the gate package's fixtures (slice of #6553) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const TESTS = import.meta.dirname;
const KIT = /apps\/cli\/tests\/fixtures/;

/** Every .js file under a folder. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []);
}

test('clause 1: no test file under packages/drive/tests imports a module of the CLI fixture kit [C7]', () => {
  const importers = walk(TESTS).filter(file => file !== import.meta.filename && KIT.test(readFileSync(file, 'utf8')));
  assert.deepEqual(importers, [], 'repoint these to packages/gate/tests/fixtures');
});
