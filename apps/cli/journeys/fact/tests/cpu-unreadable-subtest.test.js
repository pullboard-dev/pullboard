/** A subtest call with unreadable CPU options still uses its registered runner [C7]. */
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

for (const [kind, subtest] of [
  ['quoted', 't["test"]'],
  ['template', 't[`test`]'],
  ['computed', 't[["te", "st"].join("")]'],
]) test(`a ${kind} subtest call with unreadable CPU options uses its runner [C7]`, async () => {
  const box = cpuLoadFixture(e2e, { subtest,
    declaration: 'Object.fromEntries([[ ["cpu", "Load"].join(""), true ]])' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'valid computed subtest calls cannot hide unreadable CPU options');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});
