/** @pullboard-test-input source-tree package.json */
/** The gate move leaves the runner worker closure unchanged: the same eight modules, each behind its old path [C7,doctrine:CD60]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runnerPackage } from '../../../src/runner-package.js';

const ROOT = dirname(fileURLToPath(new URL('../../../package.json', import.meta.url)));
/** The gate modules the worker closure reached before the move, by their old paths. */
const BEFORE = ['src/audit-coverage-reporter.js', 'src/child-journal-preload.js', 'src/chrome-clone-check.js',
  'src/gate-stages.js', 'src/gui-session.js', 'src/test-outcomes.js', 'src/test-result-store.js', 'src/timing.js'];
/** The old paths that keep a shim: each re-exports exactly its own moved body, never the front door. */
const SHIMS = BEFORE.filter(file => file !== 'src/audit-coverage-reporter.js');

test('the runner worker closure holds the same gate modules after the move, without the front door [C7,doctrine:CD60]', () => {
  const files = Object.keys(runnerPackage(ROOT).files);
  const moved = JSON.parse(readFileSync(join(ROOT, 'bin/cells-plan/path-map/gate.json'), 'utf8'));
  const bodies = BEFORE.map(file => moved[file]);
  assert.ok(bodies.every(body => typeof body === 'string' && body.startsWith('packages/gate/src/')), 'every old module has a moved body');
  for (const body of bodies) assert.ok(files.includes(body), `${body} stays in the closure`);
  for (const shim of SHIMS) assert.ok(files.includes(shim), `${shim} stays in the closure`);
  assert.ok(!files.includes('src/audit-coverage-reporter.js'), 'the reporter has no shim; it is reached at its body');
  const gate = files.filter(file => file.startsWith('packages/gate/'));
  assert.deepEqual(gate.sort(), [...bodies, 'packages/gate/core.js'].sort(), 'no other gate module enters the closure');
  assert.ok(!files.includes('packages/gate/index.js'), 'the worker does not load the gate front door');
});

test('every closure shim re-exports exactly its own moved body [C7,doctrine:CD60]', () => {
  const moved = JSON.parse(readFileSync(join(ROOT, 'bin/cells-plan/path-map/gate.json'), 'utf8'));
  for (const shim of SHIMS) {
    const text = readFileSync(join(ROOT, shim), 'utf8').trim();
    const match = /^export \{ [\w$, ]+ \} from "((?:\.\.\/)+packages\/gate\/src\/[\w/-]+\.js)";$/u.exec(text);
    assert.ok(match, `${shim} is one named re-export`);
    assert.equal(join(dirname(shim), match[1]), moved[shim], `${shim} targets its own body`);
  }
});

/** The store body replaces only its old forwarding shim in the runner closure [C7]. */
test('runner reads the native user directory body without widening its closure [C7]', () => {
  const files = Object.keys(runnerPackage(ROOT).files);
  assert.ok(files.includes('packages/store/src/shell/native-user-directory.js'));
  assert.deepEqual(files.filter(file => file.endsWith('native-user-directory.js')), ['packages/store/src/shell/native-user-directory.js']);
  assert.ok(!files.includes('packages/store/index.js'));
});
