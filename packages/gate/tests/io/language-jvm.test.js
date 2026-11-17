/** @pullboard-test-input source-cell gate */
/** The init gate detects Maven and Gradle projects without running them [#3707,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { detectGate } from '../../src/io/config.js';
import { detectLanguages } from '../../src/io/config.js';
import { detectTestGlobs } from '../../src/io/config.js';
import { privateFixtureFiles } from '../fixtures/child.js';

const JVM_GLOBS = ['**/*Test.java', '**/*Tests.java', '**/*Test.kt'];

/** Make a repo root holding the given files, removed after the test. */
function rootWith(t, files) {
  const { root, write } = privateFixtureFiles('language-jvm-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) write(name, text);
  return root;
}

test('gate.language-jvm.pom-detects-maven: clause 1: a pom.xml directory detects maven with mvn test and the Java and Kotlin globs [C7]', (t) => {
  const root = rootWith(t, { 'pom.xml': '<project/>' });
  assert.deepEqual(detectLanguages(root), [{ language: 'maven', command: 'mvn test' }]);
  assert.deepEqual(detectTestGlobs(root), JVM_GLOBS);
  assert.equal(detectGate(root), 'mvn test');
});

test('gate.language-jvm.gradlew-detects-wrapper: clause 2: a gradle build with a gradlew entry detects ./gradlew test, each marker file alike [C7]', (t) => {
  for (const marker of ['build.gradle.kts', 'build.gradle', 'settings.gradle', 'settings.gradle.kts']) {
    const root = rootWith(t, { [marker]: '', gradlew: '#!/bin/sh\n' });
    assert.deepEqual(detectLanguages(root), [{ language: 'gradle', command: './gradlew test' }], marker);
  }
});

test('gate.language-jvm.no-gradlew-detects-gradle: clause 2: a gradle build without a gradlew entry detects gradle test with the Java and Kotlin globs [C7]', (t) => {
  const root = rootWith(t, { 'build.gradle': '' });
  assert.deepEqual(detectLanguages(root), [{ language: 'gradle', command: 'gradle test' }]);
  assert.deepEqual(detectTestGlobs(root), JVM_GLOBS);
});

test('gate.language-jvm.both-build-systems-two-entries: clause 2: both build systems give two entries in table order, and the gate joins them with && [C7]', (t) => {
  const root = rootWith(t, { 'pom.xml': '<project/>', 'build.gradle.kts': '' });
  assert.deepEqual(detectLanguages(root), [
    { language: 'gradle', command: 'gradle test' },
    { language: 'maven', command: 'mvn test' },
  ]);
  assert.equal(detectGate(root), 'gradle test && mvn test');
  assert.deepEqual(detectTestGlobs(root), JVM_GLOBS);
});

test('gate.language-jvm.neither-detects-none: clause 2: a directory with neither build system detects no JVM entry [C7]', (t) => {
  const root = rootWith(t, { 'README.md': '' });
  assert.deepEqual(detectLanguages(root), []);
  assert.deepEqual(detectTestGlobs(root), []);
});
