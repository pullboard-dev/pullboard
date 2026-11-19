/** @pullboard-test-input source-cell gate */
/** The init gate detects sbt, Haskell and Perl projects from marker files alone, running nothing [#10117,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { detectLanguages } from '../../src/io/config.js';
import { detectTestGlobs } from '../../src/io/config.js';
import { privateFixtureFiles } from '../fixtures/child.js';

/** Make a repo root holding the given files, removed after the test. */
function rootWith(t, files) {
  const { root, write } = privateFixtureFiles('language-sbt-haskell-perl-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) write(name, text);
  return root;
}

test('gate.io-language-sbt-haskell-perl.build-sbt-detects-sbt-with: clause 1: build.sbt detects sbt with sbt test and its Scala test globs [#10117,C7]', (t) => {
  const root = rootWith(t, { 'build.sbt': 'name := "app"\n' });
  assert.deepEqual(detectLanguages(root), [{ language: 'sbt', command: 'sbt test' }]);
  assert.deepEqual(detectTestGlobs(root), ['**/src/test/scala/**/*.scala']);
});

test('gate.io-language-sbt-haskell-perl.stack-yaml-detects-stack-test: clause 2: stack.yaml detects stack test, a lone .cabal file cabal test, and both together stack test once [#10117,C7]', (t) => {
  assert.deepEqual(detectLanguages(rootWith(t, { 'stack.yaml': 'resolver: lts-22.0\n' })), [{ language: 'haskell', command: 'stack test' }]);
  assert.deepEqual(detectLanguages(rootWith(t, { 'foo.cabal': 'name: foo\n' })), [{ language: 'haskell', command: 'cabal test' }]);
  assert.deepEqual(detectLanguages(rootWith(t, { 'cabal.project': 'packages: .\n', 'stack.yaml': 'resolver: lts-22.0\n' })), [{ language: 'haskell', command: 'stack test' }]);
  assert.deepEqual(detectTestGlobs(rootWith(t, { 'stack.yaml': '' })), ['**/test/**/*.hs', '**/*Spec.hs']);
});

test('gate.io-language-sbt-haskell-perl.a-perl-marker-detects-prove: clause 3: a Perl marker detects prove -lr t only when a t folder exists, and nothing without it [#10117,C7]', (t) => {
  const withTests = rootWith(t, { 'Makefile.PL': 'use ExtUtils::MakeMaker;\n', 't/basic.t': 'use Test::More;\n' });
  assert.deepEqual(detectLanguages(withTests), [{ language: 'perl', command: 'prove -lr t' }]);
  assert.deepEqual(detectTestGlobs(withTests), ['t/**/*.t']);
  const without = rootWith(t, { 'Makefile.PL': 'use ExtUtils::MakeMaker;\n' });
  assert.deepEqual(detectLanguages(without), []);
  assert.deepEqual(detectTestGlobs(without), []);
});
