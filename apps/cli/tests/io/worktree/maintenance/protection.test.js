/** @pullboard-test-loads apps/cli/src/io/worktree/maintenance.js apps/cli/src/io/worktree/maintenance/classify.js apps/cli/tests/fixtures/worktree/maintenance/engine.js */
/** Maintenance never removes a joined seat, a leased claim's checkout or anything outside its own scratch area [B3,C7,#5969]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyMaintenanceTree } from '../../../../src/io/worktree/maintenance/classify.js';
import { registerMaintenanceProtectionTests } from '../../../fixtures/worktree/maintenance/engine.js';

const DAY = 24 * 60 * 60 * 1000;

registerMaintenanceProtectionTests();

test('clause 2 [test]: classification protects trees outside the scratch area whatever their age, and a retired seat stays eligible [C7,#5969]', () => {
  const NOW = Date.UTC(2026, 9, 30, 17);
  const mainRoot = '/tmp/pullboard';
  const base = { mainRoot, currentRoot: mainRoot, items: [], now: NOW, workingDirectories: [], previous: { firstSeenAt: NOW - 10 * DAY },
    config: { worktrees: 'inside', worktreeMaintenance: { grace: '1d', exclude: [] } } };
  for (const path of ['/tmp/pullboard-census', '/tmp/pullboard/.claude/worktrees/smoke-pool-1', '/tmp/elsewhere/checkout']) {
    const result = classifyMaintenanceTree({ path }, { ...base, seats: [] });
    assert.equal(result.protected, true, path);
    assert.equal(result.reason, 'outside-maintenance-scratch');
  }
  const seatPath = '/tmp/pullboard/.claude/worktrees/w-1';
  const hookless = { agent_id: 'core-1', path: seatPath, presence: 'gone', heartbeatAt: null, createdAt: NOW - 10 * DAY };
  assert.equal(classifyMaintenanceTree({ path: seatPath }, { ...base, seats: [hookless] }).reason, 'seat-joined');
  const retired = classifyMaintenanceTree({ path: seatPath }, { ...base, seats: [{ ...hookless, completedTakeoverAt: NOW - 2 * DAY }] });
  assert.equal(retired.protected, false);
  assert.equal(retired.oldEnough, true);
});

test('clause 3 [test]: a retired seat spare is removable, a live seat spare is kept, a stray spare name is kept [C7,#5776]', () => {
  const NOW = Date.UTC(2026, 9, 30, 17);
  const mainRoot = '/tmp/pullboard';
  const base = { mainRoot, currentRoot: mainRoot, items: [], now: NOW, workingDirectories: [], previous: { firstSeenAt: NOW - 10 * DAY },
    config: { worktrees: 'inside', worktreeMaintenance: { grace: '1d', exclude: [] } } };
  const seatPath = '/tmp/pullboard/.claude/worktrees/w-1';
  const spare = { path: `${seatPath}-spare` };
  const seat = { agent_id: 'core-1', path: seatPath, presence: 'gone', heartbeatAt: null, createdAt: NOW - 10 * DAY };
  const live = classifyMaintenanceTree(spare, { ...base, seats: [seat] });
  assert.equal(live.protected, true);
  assert.equal(live.reason, 'seat-joined');
  const retired = classifyMaintenanceTree(spare, { ...base, seats: [{ ...seat, completedTakeoverAt: NOW - 2 * DAY }] });
  assert.equal(retired.protected, false);
  assert.equal(retired.oldEnough, true);
  const stray = classifyMaintenanceTree({ path: '/tmp/pullboard/.claude/worktrees/other-spare' }, { ...base, seats: [seat] });
  assert.equal(stray.protected, true);
  assert.equal(stray.reason, 'outside-maintenance-scratch');
});
