/** Maintenance removes a hand-made worktree only once its item is provably finished and it has idled 2 hours; protection stays [C7,#5733,#5969]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyMaintenanceTree } from '../../../../src/io/worktree/maintenance/classify.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 12, 17);
const HEAD = 'a'.repeat(40);
const mainRoot = '/tmp/pullboard';
const base = { mainRoot, currentRoot: mainRoot, seats: [], now: NOW, workingDirectories: [],
  config: { worktrees: 'inside', worktreeMaintenance: { grace: '1d', exclude: [] } } };
const handMade = { path: '/tmp/pullboard/.claude/worktrees/smoke-pool-1', head: HEAD };
const landed = { item_id: 7, item_status: 'landed', item_commit: HEAD, item_merged_commit: 'b'.repeat(40) };

test('cli.io-worktree-maintenance-finished.clause-1-test-a-hand-made-worktree: clause 1 [test]: a hand-made worktree whose item landed or was withdrawn is removable after 2 h idle, not before [C7,#5733]', () => {
  for (const item of [landed, { ...landed, item_merged_commit: null, item_status: 'withdrawn' }]) {
    const idle = classifyMaintenanceTree(handMade, { ...base, items: [item], previous: { firstSeenAt: NOW - 3 * HOUR } });
    assert.equal(idle.protected, false);
    assert.equal(idle.kind, 'finished');
    assert.equal(idle.oldEnough, true);
    const young = classifyMaintenanceTree(handMade, { ...base, items: [item], previous: { firstSeenAt: NOW - HOUR } });
    assert.equal(young.oldEnough, false);
  }
});

test('cli.io-worktree-maintenance-finished.clause-1-test-a-hand-made-worktree-2: clause 1 [test]: a hand-made worktree with no finished item, an open item, or outside the scratch area stays protected [C7,#5733,#5969]', () => {
  const old = { firstSeenAt: NOW - 10 * HOUR };
  const none = classifyMaintenanceTree(handMade, { ...base, items: [], previous: old });
  assert.equal(none.protected, true);
  assert.equal(none.reason, 'outside-maintenance-scratch');
  const otherHead = classifyMaintenanceTree(handMade, { ...base, items: [{ ...landed, item_commit: 'c'.repeat(40) }], previous: old });
  assert.equal(otherHead.protected, true);
  const open = classifyMaintenanceTree(handMade, { ...base, items: [{ ...landed, item_merged_commit: null, item_status: 'claimed' }], previous: old });
  assert.equal(open.protected, true);
  const outside = classifyMaintenanceTree({ path: '/tmp/elsewhere/checkout', head: HEAD }, { ...base, items: [landed], previous: old });
  assert.equal(outside.protected, true);
  assert.equal(outside.reason, 'outside-maintenance-scratch');
});

test('cli.io-worktree-maintenance-finished.clause-2-test-a-locked-finished-worktree: clause 2 [test]: a locked finished worktree is never removed [C7,#5733]', () => {
  const locked = classifyMaintenanceTree({ ...handMade, locked: true }, { ...base, items: [landed], previous: { firstSeenAt: NOW - 10 * HOUR } });
  assert.equal(locked.protected, true);
  assert.equal(locked.reason, 'git-worktree-locked');
});
