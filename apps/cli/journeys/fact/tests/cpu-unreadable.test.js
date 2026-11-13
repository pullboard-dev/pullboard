/** Unreadable CPU-load options conservatively use a registered runner [C7]. */
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

// These conservative-placement controls were added after the coordinator sharpened the contract.
for (const [kind, declaration, binding] of [
  ['computed property', '{ [["cpu", "Load"].join("")]: true }', 'test'],
  ['spread property', '{ ...Object.fromEntries([[ ["cpu", "Load"].join(""), true ]]) }', 'test'],
  ['opaque options and an imported alias', 'Object.fromEntries([[ ["cpu", "Load"].join(""), true ]])', 'register'],
  ['invoked option factory', '(() => Object.fromEntries([[ ["cpu", "Load"].join(""), true ]]))()', 'test'],
]) test(`unreadable ${kind} options conservatively use a registered runner [C7]`, async () => {
  const box = cpuLoadFixture(e2e, { declaration, binding });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'unresolved executable options cannot start on the coordinator');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});
