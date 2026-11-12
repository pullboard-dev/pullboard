/** The board and the queued worker share one infrastructure code set, so no machinery code returns a builder red [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INFRASTRUCTURE_CODES as worker } from '../../../../index.js';
import { INFRASTRUCTURE_CODES as board } from '../../../../../../packages/store/index.js';

test('the board-side infrastructure code set equals the worker set and covers exhausted retries [C7,V4]', () => {
  assert.deepEqual([...board].sort(), [...worker].sort());
  for (const code of ['RUNNER_INFRA_RETRY_EXHAUSTED', 'GATE_INFRA_EXHAUSTED', 'GIT_READ_INFRASTRUCTURE']) assert.ok(board.has(code), code);
});
