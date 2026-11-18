/** @pullboard-test-input source-cell gate */
/** Language rows: one data table adds ecosystems without new detection code [#3707,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { detectLanguages } from '../../src/io/config.js';
import { detectTestGlobs } from '../../src/io/config.js';
import { LANGUAGE_ROWS } from '../../src/logic/language-rows.js';
import { rowMatches } from '../../src/logic/language-rows.js';
import { privateFixtureFiles } from '../fixtures/child.js';

/** Make a repo root holding the given files, removed after the test. */
function rootWith(t, files) {
  const { root, write } = privateFixtureFiles('language-rows-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) write(name, text);
  return root;
}

test('gate.io-language-rows.a-fake-row-table-matches: clause 1: a fake row table matches by marker, pattern, requires and function command in table order [C7]', (t) => {
  const rows = [
    { language: 'alpha', markers: ['alpha.cfg'], command: 'alpha test', tests: ['**/*.alpha'] },
    { language: 'beta', pattern: /\.beta$/u, command: 'beta test', tests: ['**/*.b'] },
    { language: 'gamma', markers: ['gamma.cfg'], requires: { file: 'gamma.cfg', includes: 'test' }, command: 'gamma test', tests: [] },
    { language: 'delta', markers: ['delta.cfg'], requires: { file: 'delta.cfg', includes: 'test' }, command: 'delta test', tests: [] },
    { language: 'eps', markers: ['gradlew'], command: (names) => (names.includes('gradlew') ? './gradlew test' : 'gradle test'), tests: [] },
  ];
  const root = rootWith(t, { 'eps.beta': '', 'gradlew': '', 'gamma.cfg': 'run test', 'delta.cfg': 'nothing', 'alpha.cfg': '' });
  assert.deepEqual(detectLanguages(root, rows), [
    { language: 'alpha', command: 'alpha test' },
    { language: 'beta', command: 'beta test' },
    { language: 'gamma', command: 'gamma test' },
    { language: 'eps', command: './gradlew test' },
  ]);
  assert.deepEqual(detectTestGlobs(root, rows), ['**/*.alpha', '**/*.b']);
  assert.equal(rowMatches(rows[0], [], () => null), false);
  assert.equal(rowMatches(rows[1], ['x.beta'], () => null), true);
  assert.equal(rowMatches({ ...rows[1], pattern: /\.beta$/gu }, ['x.beta', 'y.beta'], () => null), true);
});

test('gate.io-language-rows.the-shipped-rows-leave-detectlanguages: clause 2: the shipped rows leave detectLanguages and detectTestGlobs unchanged for a go.mod directory [C7]', (t) => {
  const root = rootWith(t, { 'go.mod': 'module example.test/project\n' });
  assert.equal(LANGUAGE_ROWS.some((row) => row.markers?.includes('go.mod')), false);
  assert.equal(Object.isFrozen(LANGUAGE_ROWS), true);
  assert.deepEqual(detectLanguages(root), [{ language: 'go', command: 'go test ./...' }]);
  assert.deepEqual(detectLanguages(root, []), detectLanguages(root));
  assert.deepEqual(detectTestGlobs(root), ['**/*_test.go']);
});
