/** @pullboard-test-input source-cell gate */
/** The init gate detects Deno and Bun without doubling an npm test [#3707,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { detectLanguages } from '../../src/io/config.js';
import { detectTestGlobs } from '../../src/io/config.js';
import { privateFixtureFiles } from '../fixtures/child.js';

/** Make a repo root holding the given files, removed after the test. */
function rootWith(t, files) {
  const { root, write } = privateFixtureFiles('language-js-runtimes-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) write(name, text);
  return root;
}

test('clause 1: deno.json alone detects deno test with its test globs [C7]', (t) => {
  const root = rootWith(t, { 'deno.json': '{}' });
  assert.deepEqual(detectLanguages(root), [{ language: 'deno', command: 'deno test' }]);
  assert.deepEqual(detectTestGlobs(root), ['**/*_test.ts', '**/*.test.ts', '**/*_test.js']);
});

test('clause 1: a bun lockfile without a package.json test script detects bun test with its test globs [C7]', (t) => {
  const root = rootWith(t, { 'bun.lock': '' });
  assert.deepEqual(detectLanguages(root), [{ language: 'bun', command: 'bun test' }]);
  assert.deepEqual(detectTestGlobs(root), ['**/*.test.ts', '**/*.test.js', '**/*.spec.ts']);
  const withBinary = rootWith(t, { 'bun.lockb': '' });
  assert.deepEqual(detectLanguages(withBinary), [{ language: 'bun', command: 'bun test' }]);
  const withConfig = rootWith(t, { 'bunfig.toml': '' });
  assert.deepEqual(detectLanguages(withConfig), [{ language: 'bun', command: 'bun test' }]);
});

test('clause 1: a bun lockfile with a package.json that has no scripts.test or only the npm default still detects bun test [C7]', (t) => {
  const bare = rootWith(t, { 'bun.lock': '', 'package.json': '{"name":"x"}' });
  assert.deepEqual(detectLanguages(bare), [{ language: 'bun', command: 'bun test' }]);
  const stub = rootWith(t, { 'bun.lock': '', 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  assert.deepEqual(detectLanguages(stub), [{ language: 'bun', command: 'bun test' }]);
  const broken = rootWith(t, { 'bun.lock': '', 'package.json': '{ not json' });
  assert.deepEqual(detectLanguages(broken), [{ language: 'bun', command: 'bun test' }]);
});

test('clause 2: a bun lockfile with a package.json test script gives the node entry only [C7]', (t) => {
  const root = rootWith(t, { 'bun.lock': '', 'package.json': '{"scripts":{"test":"vitest run"}}' });
  assert.deepEqual(detectLanguages(root), [{ language: 'node', command: 'npm test' }]);
  assert.equal(detectLanguages(root).some((entry) => entry.language === 'bun'), false);
});

test('clause 2: deno stays independent of a package.json test script and lists after bun in table order [C7]', (t) => {
  const root = rootWith(t, { 'deno.jsonc': '{}', 'bun.lockb': '', 'package.json': '{"scripts":{"test":"vitest run"}}' });
  assert.deepEqual(detectLanguages(root), [{ language: 'node', command: 'npm test' }, { language: 'deno', command: 'deno test' }]);
  const both = rootWith(t, { 'deno.jsonc': '{}', 'bun.lockb': '' });
  assert.deepEqual(detectLanguages(both), [{ language: 'bun', command: 'bun test' }, { language: 'deno', command: 'deno test' }]);
});
