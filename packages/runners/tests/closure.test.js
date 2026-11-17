/** @pullboard-test-input source-tree package.json */
/** The gate move leaves the runner worker closure unchanged: the same eight modules, each at its moved body, plus the preload's journal source split out of it [C7,doctrine:CD60]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runnerPackage } from '../index.js';

const ROOT = dirname(fileURLToPath(new URL('../../../package.json', import.meta.url)));
/** The gate modules the worker closure reached before the move, by their old paths. */
const BEFORE = ['src/audit-coverage-reporter.js', 'src/child-journal-preload.js', 'src/chrome-clone-check.js',
  'src/gate-stages.js', 'src/gui-session.js', 'src/test-outcomes.js', 'src/test-result-store.js', 'src/timing.js'];
test('runners.closure.the-runner-worker-closure-holds-the: the runner worker closure holds the same gate modules after the move, without the front door [C7,doctrine:CD60]', () => {
  const files = Object.keys(runnerPackage(ROOT).files);
  const moved = JSON.parse(readFileSync(join(ROOT, 'packages/codemap/data/plan/path-map/gate.json'), 'utf8'));
  const bodies = BEFORE.map(file => moved[file]);
  assert.ok(bodies.every(body => typeof body === 'string' && body.startsWith('packages/gate/src/')), 'every old module has a moved body');
  for (const body of bodies) assert.ok(files.includes(body), `${body} stays in the closure`);
  for (const old of BEFORE) assert.ok(!files.includes(old), `${old} left no shim in the closure`);
  const gate = files.filter(file => file.startsWith('packages/gate/'));
  // Deliberate additions: the preload's journal source split into its own module (d75861e52d), which the preload imports; the user directory read that the Chrome clone check, now in this cell, imports (#4808); the runner source identity that gate/light.js re-exports for the runner main, request and result modules; the store-name registry const that the result store imports (#7003); the CLA check that gate/light.js re-exports for landing (9b28bc0e55); and the JUnit logic the test outcomes module imports.
  assert.deepEqual(gate.sort(), [...bodies, 'packages/gate/src/io/journal/source.js', 'packages/gate/src/io/directory.js', 'packages/gate/src/logic/runner-source.js', 'packages/gate/src/io/store-names.js', 'packages/gate/src/io/check/cla.js', 'packages/gate/src/logic/junit.js', 'packages/gate/light.js'].sort(), 'no other gate module enters the closure');
  assert.ok(!files.includes('packages/gate/index.js'), 'the worker does not load the gate front door');
});

/** The store body replaces only its old forwarding shim in the runner closure [C7]. */
test('runners.closure.runner-reads-the-native-user-directory: runner reads the native user directory body without widening its closure [C7]', () => {
  const files = Object.keys(runnerPackage(ROOT).files);
  assert.ok(files.includes('packages/gate/src/io/directory.js'));
  assert.deepEqual(files.filter(file => file.endsWith('/directory.js')), ['packages/gate/src/io/directory.js']);
  assert.ok(!files.includes('packages/store/index.js'));
});
