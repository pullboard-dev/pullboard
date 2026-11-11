/** Hidden test registration through odd import bindings still places declared CPU load on a runner [C7]. */
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

// Test-first binding controls: imported opaque options must not evade registration discovery.
for (const [kind, importBinding, moduleSpecifier] of [
  ['commented', 'test /* registration */ as check', 'node:test'],
  ['quoted', "'test' as check", 'node:test'],
  ['escaped module', 'test as check', String.raw`node:t\u0065st`],
]) test(`a ${kind} test import with opaque imported options uses its runner [C7]`, async () => {
  const box = cpuLoadFixture(e2e, { binding: 'check', importBinding, moduleSpecifier,
    importedOptions: true, declaration: 'options' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'valid import binding syntax cannot hide unreadable test options');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});
