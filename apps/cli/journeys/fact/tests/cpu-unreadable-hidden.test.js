/** Unreadable prototype and accessor options cannot hide a CPU-load declaration [C7]. */
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
