/** @pullboard-test-loads apps/cli/src/io/worktree/maintenance.js apps/cli/src/io/worktree/maintenance/classify.js apps/cli/tests/fixtures/worktree/maintenance/engine.js */
/** Maintenance retires a joined seat idle past the takeover window with no claim, then prunes its clean, merged tree [B3,C7,#8199]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyMaintenanceTree } from '../../../../src/io/worktree/maintenance/classify.js';
import { registerMaintenanceIdleSeatTests } from '../../../fixtures/worktree/maintenance/engine.js';

registerMaintenanceIdleSeatTests();

test('cli.io-worktree-maintenance-idle-seat.clause-1-test-classification-retires-an-idle: clause 1 [test]: classification retires an idle joined seat only when a takeover window is known and has passed [C7,#8199]', () => {
  const NOW = Date.UTC(2026, 10, 15, 12), MIN = 60_000, DAY = 24 * 60 * MIN;
  const path = '/tmp/pullboard/.claude/worktrees/w-1';
  const base = { mainRoot: '/tmp/pullboard', currentRoot: '/tmp/pullboard', items: [], now: NOW, workingDirectories: [],
    previous: { firstSeenAt: NOW - 10 * DAY }, config: { worktrees: 'inside', worktreeMaintenance: { grace: '1d', exclude: [] } } };
  const seat = { agent_id: 'core-1', path, presence: 'gone', heartbeatAt: NOW - 2 * DAY };
  const idle = classifyMaintenanceTree({ path }, { ...base, seats: [seat], takeoverMs: 30 * MIN });
  assert.equal(idle.protected, false);
  assert.equal(idle.retiredIdle, true);
  assert.equal(classifyMaintenanceTree({ path }, { ...base, seats: [seat] }).reason, 'seat-joined', 'no known window keeps the seat');
  assert.equal(classifyMaintenanceTree({ path }, { ...base, seats: [{ ...seat, heartbeatAt: NOW - 5 * MIN, presence: 'live' }], takeoverMs: 30 * MIN }).reason, 'seat-live');
  const claim = { item_id: 9, item_status: 'claimed', item_owner: 'core-1' };
  assert.equal(classifyMaintenanceTree({ path }, { ...base, seats: [seat], items: [claim], takeoverMs: 30 * MIN }).reason, 'claim');
});
