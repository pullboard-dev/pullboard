/** @pullboard-test-input apps/relay/tests/** */
/** The relay app's tests name the exact files they read, so affected-test selection can see them [C7]. */
/** @pullboard-world-pin: the clauses read the relay app's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';
import { declaresSource } from '../../../packages/gate/src/io/test/inputs.js';
import { testInputProblems } from '../../../packages/gate/src/io/test/inputs.js';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'apps/relay/tests/inputs.test.js';
// The tests that read repo files by path, and the header each carries: exact files (or one folder glob), never a cell and never the whole tree.
const READERS = {
  'apps/relay/tests/io/push-optin.test.js': ['apps/relay/src/io/browser/push-client.js', 'apps/relay/src/io/browser/push-sw.js'],
  'apps/relay/tests/io/deploy/dockerfile.test.js': ['apps/relay/src/io/deploy/Dockerfile', 'package.json', 'CHANGELOG.md', 'apps/**', 'packages/**'],
  'apps/relay/tests/io/deploy/health.test.js': ['package.json'],
  'apps/relay/tests/v093-data-folder.test.js': ['apps/relay/tests/fixtures/v093-data/**'],
};

/** Every test file under the relay app's tests folder, as repo-relative paths. */
function relayTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return relayTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('relay.inputs.declared: clause 1: every relay test that reads repo files carries @pullboard-test-input lines naming the exact files it reads, never a whole cell [C7]', () => {
  const files = relayTests();
  assert.ok(files.length > 30, 'the relay app has test files to check');
  for (const [file, tokens] of Object.entries(READERS)) {
    const header = read(file).split(/\r?\n/u).slice(0, 3).find((line) => line.includes('@pullboard-test-input'));
    assert.equal(header, `/** @pullboard-test-input ${tokens.join(' ')} */`, `${file} names exactly the files it reads`);
    assert.ok(declaresSource(read(file)), `${file} declares its inputs`);
    for (const token of tokens) {
      assert.ok(!/^source-(?:cell|tree)$/u.test(token) && !token.startsWith('/') && !token.includes('..'), `${file}: ${token} is a repo path`);
      assert.ok(existsSync(join(ROOT, token.replace(/\/\*\*$/u, ''))), `${file}: ${token} exists`);
    }
  }
});

test('relay.inputs.rule-clean: clause 1: with the outside-src rule on, the reader rule reports none in apps/relay/tests, and none of the named readers carries a source-cell header [C7]', () => {
  const files = relayTests();
  assert.ok(files.includes(SELF));
  assert.deepEqual(testInputProblems(ROOT, files, read, true), []);
  const cells = Object.keys(READERS).filter((file) => /@pullboard-test-input source-cell/u.test(read(file)));
  assert.deepEqual(cells, []);
});
