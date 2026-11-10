/** @pullboard-test-loads apps/cli/src/io/worktree/maintenance/retention.js */
/** Deferred cleanup stays visible without reading protected or missing worktrees [B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retainedMaintenanceHealth } from '../../../../src/io/worktree/maintenance/retention.js';

export function registerMaintenanceRetentionTests() {
  test('retained withdrawal health projects metadata without touching absent target paths [B3,C7]', () => {
    const path = '/nonexistent-maintenance-retention-fixture';
    const retained = { item: 2059, agent: 'fixture-seat', at: '2026-10-30T00:00:00.000Z', reason: 'native cleanup deferred' };
    const state = { version: 1, trees: { [path]: { dirtySince: retained.at, retainedWithdrawal: retained } } };
    const before = JSON.stringify(state);
    assert.deepEqual(retainedMaintenanceHealth(state), [{ path, since: retained.at, reason: retained.reason,
      kind: 'withdrawal-retained', item: 2059 }]);
    assert.equal(JSON.stringify(state), before, 'health leaves authoritative observations unchanged');
    assert.deepEqual(retainedMaintenanceHealth({ trees: { relative: { retainedWithdrawal: retained },
      '/bad-time': { retainedWithdrawal: { ...retained, at: 'unknown' } },
      '/bad-item': { retainedWithdrawal: { ...retained, item: null } }, '/ordinary': {} } }), []);
    assert.deepEqual(retainedMaintenanceHealth(null), []);
  });
}
