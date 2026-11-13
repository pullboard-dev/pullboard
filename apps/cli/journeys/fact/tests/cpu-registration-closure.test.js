/** Hidden test registration through local closures still places declared CPU load on a runner [C7]. */
/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { cpuLoadFixture } from '../../../tests/fixtures/test.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

// Test-first module-closure control: a local barrel is executable registration, not textual metadata.
test('a registration re-export chain with imported opaque options uses its runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { registrationHelper: true, importedOptions: true,
    binding: 'register', importBinding: 'launch as register', moduleSpecifier: './registration-barrel.js',
    declaration: 'options' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'a local re-export closure cannot hide registration with unreadable options');
  assert.equal(remote.executor?.liveLease, true);
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});


// AFTER-only: wrapping a registration function does not make its executable provenance readable.
test('a local exported registration wrapper with opaque options uses its runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { registrationHelper: 'wrapper', importedOptions: true,
    binding: 'register', importBinding: 'launch as register', moduleSpecifier: './registration-barrel.js',
    declaration: 'options' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1);
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});
