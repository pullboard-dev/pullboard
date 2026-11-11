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


for (const [kind, declaration] of [
  ['escaped prototype', String.raw`{ "__pr\u006fto__": Object.fromEntries([[ ["cpu", "Load"].join(""), true ]]) }`],
  ['computed accessor', '{ get ["cpuLoad"]() { return true; } }'],
]) test(`unreadable ${kind} options cannot hide a CPU-load declaration [C7]`, async () => {
  const box = cpuLoadFixture(e2e, { declaration });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'unreadable prototype or accessor options require the registered runner');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});


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
