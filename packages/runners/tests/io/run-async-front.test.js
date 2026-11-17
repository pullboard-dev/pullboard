/** @pullboard-test-input source-cell runners */
/** The live async runner front sits in run-async.js, apart from the SSH controller in dispatch.js [C7,#9890,#9056]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunnerDropped } from '../../../gate/light.js';
import * as index from '../../index.js';
import * as dispatch from '../../src/io/dispatch.js';
import * as front from '../../src/io/run-async.js';

test('clause 1: the runners index exports runOnRunnerAsync, bridgeDeadlineMs and refuseLegacyControllerEntry from run-async.js, and dispatch.js exports none of them [C7,#9890]', () => {
  assert.equal(index.dispatchRunOnRunnerAsync, front.runOnRunnerAsync);
  assert.equal(index.bridgeDeadlineMs, front.bridgeDeadlineMs);
  assert.equal(index.refuseLegacyControllerEntry, front.refuseLegacyControllerEntry);
  for (const name of ['runOnRunnerAsync', 'bridgeDeadlineMs', 'refuseLegacyControllerEntry']) {
    assert.equal(typeof front[name], 'function', `run-async.js exports ${name}`);
    assert.equal(Object.hasOwn(dispatch, name), false, `dispatch.js no longer exports ${name}`);
  }
});

test('clause 2: runOnRunnerAsync through the index with a stub runner keeps its result shape: an aborted run refuses with RunnerDropped naming the host [C7,#9890]', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    index.dispatchRunOnRunnerAsync(process.cwd(), 'true', { runner: { host: 'stub-runner', slots: 1, browser: 0 }, signal: controller.signal }),
    error => error instanceof RunnerDropped && /stub-runner/u.test(error.message),
  );
  assert.equal(front.bridgeDeadlineMs({}, 0), null, 'a request with no timeout keeps no bridge deadline');
  assert.equal(front.bridgeDeadlineMs({ timeoutMs: 1000 }, 0), 1000 + 120_000, 'a timeout gains the bridge grace');
});
