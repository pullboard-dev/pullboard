/** @pullboard-test-input source-cell gate */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedUnitManifest } from '../../src/logic/selection-unit.js';
import { selectionUnits } from '../../src/logic/selection-unit.js';

const MAVEN = ['pom.xml', 'src/main/java/App.java', 'svc/pom.xml', 'svc/src/main/java/Svc.java', 'svc/src/test/java/SvcTest.java'];
const GRADLE = ['build.gradle', 'app/build.gradle.kts', 'app/src/main/kotlin/A.kt', 'lib/build.gradle', 'docs/readme.md'];

test('gate.selection-unit-module.maven: clause 1: unit module maps a changed Java file to the nearest folder above it that holds a pom.xml [C7]', () => {
  assert.deepEqual(selectionUnits('module', ['svc/src/main/java/Svc.java', 'svc/src/test/java/SvcTest.java'], MAVEN), { units: ['svc'], full: false, reason: null });
  assert.deepEqual(selectionUnits('module', ['src/main/java/App.java', 'svc/src/main/java/Svc.java'], MAVEN).units, ['.', 'svc']);
});

test('gate.selection-unit-module.gradle: clause 2: a gradle build marks a module the same way and a path under no module but the root maps to the root [C7]', () => {
  assert.deepEqual(selectionUnits('module', ['app/src/main/kotlin/A.kt', 'lib/build.gradle'], GRADLE).units, ['app', 'lib']);
  assert.deepEqual(selectionUnits('module', ['docs/readme.md'], GRADLE).units, ['.']);
  assert.equal(selectionUnits('module', ['x/y.java'], ['svc/pom.xml']).full, true, 'no module and no root manifest gives the full gate with a reason');
});

test('gate.selection-unit-module.manifests: clause 3: a changed pom.xml, build.gradle(.kts) or settings.gradle(.kts) is named by changedUnitManifest [C7]', () => {
  for (const name of ['pom.xml', 'svc/build.gradle', 'app/build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) assert.equal(changedUnitManifest(['src/A.java', name]), name);
  assert.equal(changedUnitManifest(['src/A.java']), null);
});
