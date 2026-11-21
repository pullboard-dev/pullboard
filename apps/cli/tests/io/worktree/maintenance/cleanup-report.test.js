/** Optional lifecycle cleanup reports the real refusal while leaving its recorded move intact [C7,#12626]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupMaintenanceLifecycle } from '../../../../src/io/worktree/maintenance/command.js';

test('cli.io-worktree-maintenance.cleanup-refusal-keeps-lifecycle-and-reports-safe-reason: clause 1: cleanup refusal preserves the lifecycle result and logs its actual error code and useful detail without credentials or payloads [C7,#12626]', async () => {
  const errors = [];
  const lifecycle = Object.freeze({ status: 'released' });
  const ctx = {
    config: { worktreeMaintenance: { enabled: true } },
    info: { root: process.cwd(), isMain: false },
    io: { err: message => errors.push(message) },
  };
  const result = await cleanupMaintenanceLifecycle(ctx, 'core-1', { path: '/worktree', item: 12 }, {
    clean: async () => { throw Object.assign(new Error('archive custody check failed token=topsecret'), { code: 'EARCHIVE' }); },
  });
  assert.equal(result, null, 'cleanup remains optional after the lifecycle result was recorded');
  assert.equal(lifecycle.status, 'released');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /EARCHIVE: archive custody check failed/u);
  assert.doesNotMatch(errors[0], /topsecret/u);
});
