/** An ssh-path job runs with PULLBOARD_RUNNER_TOOLS naming the worker's installed Pullboard, so a trusted step can judge a non-Pullboard main [C7,#10998]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { scopedEnvironment } from '../../../src/io/worker/environment.js';

test('runner.worker-environment.runner-tools-names-the-install: clause 1: scopedEnvironment sets PULLBOARD_RUNNER_TOOLS to the installed Pullboard root, the folder holding packages/items, whatever the job temporary folder is [C7]', () => {
  const S = { safePath: '/usr/bin:/bin', workerId: 'job-1' };
  const api = { gateSlotEnvironment: () => ({}) };
  const env = scopedEnvironment(S, '/nowhere/home', '/nowhere/tmp', '', null, api);
  assert.ok(env.PULLBOARD_RUNNER_TOOLS, 'the variable is set');
  assert.equal(env.PULLBOARD_RUNNER_TOOLS, resolve(import.meta.dirname, '../../../../..'), 'it names the repo root, the folder that holds packages/items');
  const other = scopedEnvironment(S, '/nowhere/home', '/elsewhere/tmp', '', null, api);
  assert.equal(other.PULLBOARD_RUNNER_TOOLS, env.PULLBOARD_RUNNER_TOOLS, 'the install root does not depend on the job');
});
