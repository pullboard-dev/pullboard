/** Hidden test registration still places declared CPU load on a runner [C7]. */
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

// AFTER-only negative: a readable direct subtest and its ordinary lifecycle hook are not opaque load.
test('a readable false direct subtest and context lifecycle hook stay local [C7]', async () => {
  const box = cpuLoadFixture(e2e, { subtest: 't.test', declaration: '{ cpuLoad: false }' });
  const local = await box.runGate();
  assert.equal(local.result.status, 0, local.result.context);
  assert.equal(box.requestsMade().length, 0);
  assert.equal(local.executor?.cwd, box.repo);
  assert.equal(local.executor?.liveLease, true);
  assert.equal(local.executor?.runnerExecution, false);
});


// AFTER-only: unresolved CommonJS registration is conservatively placed without executing it.
test('opaque CommonJS registration uses its genuine runner and browser lease [C7]', async () => {
  const box = cpuLoadFixture(e2e, { commonjs: true, binding: 'register',
    declaration: 'Object.fromEntries([[ ["cpu", "Load"].join(""), true ]])' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1);
  assert.equal(remote.executor?.runnerExecution, true);
  assert.equal(remote.executor?.browserLease, true, 'the conservative CommonJS browser requirement has a real private holder');
  assert.notEqual(remote.executor?.cwd, box.repo);
});


// AFTER-only: dynamic module loading cannot hide a registration alias with executable options.
test('dynamic node:test registration with opaque options uses its runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { dynamicImport: true, binding: 'register',
    declaration: 'Object.fromEntries([[ ["cpu", "Load"].join(""), true ]])' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1);
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});
