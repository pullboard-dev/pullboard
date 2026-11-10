import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyMaintenanceTree } from '../../../../src/io/worktree/maintenance/classify.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 30, 17);

/** Give each classification case a stable fake checkout and a complete process census. */
function input(overrides = {}) {
  const mainRoot = '/tmp/pullboard';
  return {
    tree: { path: '/tmp/pullboard/.claude/worktrees/core-1', head: 'abc', locked: false, bare: false },
    mainRoot, currentRoot: '/tmp/pullboard/.claude/worktrees/core-2',
    config: { worktrees: 'inside', worktreeMaintenance: { enabled: true, every: '1h', grace: '1d', exclude: [] } },
    seats: [], items: [], previous: null, now: NOW, workingDirectories: [], ...overrides,
  };
}

/** Register pure classification checks when the owning maintenance suite imports this fixture. */
export function registerMaintenanceClassificationTests() {
  test('maintenance classification protects active seats, claims, reservations and unknown process state [B3,I4,I16]', () => {
    for (const presence of ['live', 'idle']) {
      const result = classifyMaintenanceTree(input({ seats: [{ agent_id: 'core-1', path: '/tmp/pullboard/.claude/worktrees/core-1', presence }] }).tree,
        input({ seats: [{ agent_id: 'core-1', path: '/tmp/pullboard/.claude/worktrees/core-1', presence }] }));
      assert.equal(result.kind, 'active');
      assert.equal(result.protected, true);
      assert.deepEqual(result.agents, ['core-1']);
    }

    const root = input();
    const seat = { agent_id: 'core-1', path: root.tree.path, presence: 'gone', heartbeatAt: NOW - 2 * DAY };
    for (const obligation of [
      { item_id: 1, item_owner: 'core-1', item_status: 'claimed' },
      { item_id: 2, item_review_by: 'core-1', item_review_until: new Date(NOW + HOUR).toISOString(), item_status: 'submitted' },
      { item_id: 3, item_built_by: 'core-1', item_status: 'submitted' },
      { item_id: 4, item_built_by: 'core-1', item_status: 'verified' },
    ]) {
      const result = classifyMaintenanceTree(root.tree, { ...root, seats: [seat], items: [obligation] });
      assert.equal(result.kind, 'active');
      assert.equal(result.protected, true);
      assert.deepEqual(result.items, [obligation.item_id]);
    }

    const recentUnknown = classifyMaintenanceTree(root.tree, { ...root, seats: [{ agent_id: 'core-1', path: root.tree.path, presence: null, heartbeatAt: NOW - HOUR }] });
    assert.equal(recentUnknown.kind, 'active');
    assert.equal(recentUnknown.reason, 'seat-recent-or-clock-rollback');
    assert.equal(classifyMaintenanceTree(root.tree, { ...root, workingDirectories: null }).protected, true);
    assert.equal(classifyMaintenanceTree(root.tree, { ...root, workingDirectories: [{ cwd: null }] }).protected, true);
    assert.equal(classifyMaintenanceTree(root.tree, { ...root, workingDirectories: [{ cwd: root.tree.path + '/child' }] }).reason, 'process-working-directory');
    assert.equal(classifyMaintenanceTree(root.tree, { ...root, workingDirectories: [{ pid: 1234, path: root.tree.path + '/child' }] }).reason, 'process-working-directory');
  });

  test('maintenance classification protects repository roots and configured exclusions by path component [B3,I4,I16]', () => {
    const base = input();
    for (const tree of [
      { path: base.mainRoot, locked: false, bare: false },
      { path: base.currentRoot, locked: false, bare: false },
      { path: '/tmp/pullboard/.claude/worktrees/locked', locked: true, bare: false },
      { path: '/tmp/pullboard/.claude/worktrees/bare', locked: false, bare: true },
      { path: '/tmp/pullboard/.claude/worktrees/keep', locked: false, bare: false },
    ]) {
      const context = { ...base, tree, config: { ...base.config, worktreeMaintenance: { ...base.config.worktreeMaintenance, exclude: ['/tmp/pullboard/.claude/worktrees/keep'] } } };
      const result = classifyMaintenanceTree(tree, context);
      assert.equal(result.protected, true);
      assert.equal(result.kind, 'active');
    }
    const beside = input({ config: { worktrees: 'beside', worktreeMaintenance: { grace: '1d', exclude: [] } },
      tree: { path: '/tmp/pullboard-agent-1', locked: false, bare: false } });
    assert.equal(classifyMaintenanceTree(beside.tree, beside).kind, 'orphaned');
    const siblingPrefix = input({ config: { worktrees: 'beside', worktreeMaintenance: { grace: '1d', exclude: [] } },
      tree: { path: '/tmp/pullboardish-agent-1', locked: false, bare: false } });
    assert.equal(classifyMaintenanceTree(siblingPrefix.tree, siblingPrefix).kind, 'scratch');
    const insideCandidate = input({ previous: { firstSeenAt: NOW - DAY } });
    const inside = classifyMaintenanceTree(insideCandidate.tree, insideCandidate);
    assert.equal(inside.kind, 'orphaned');
    assert.equal(inside.protected, false);
    assert.equal(inside.oldEnough, true);
  });

  test('maintenance classification always protects the retained recovery checkout and overlapping paths [B3,I4,I16]', () => {
    const protectedRoot = join(homedir(), 'Code', 'pullboard');
    const paths = [protectedRoot, join(protectedRoot, 'nested-checkout'), join(homedir(), 'Code')];
    for (const path of paths) {
      const context = input({ tree: { path, locked: false, bare: false },
        config: { worktrees: 'beside', worktreeMaintenance: { enabled: true, grace: '1ms', exclude: [] } } });
      const result = classifyMaintenanceTree(context.tree, context);
      assert.equal(result.kind, 'active');
      assert.equal(result.protected, true);
      assert.equal(result.reason, 'recovery-checkout');
    }
  });

  test('maintenance classification uses native gone age and exact grace boundaries, never inventing age from mtime [B3,I4,I16]', () => {
    const base = input();
    const tree = base.tree;
    const closed = [{ item_id: 1, item_built_by: 'core-1', item_status: 'verified', item_merged_commit: 'def' },
      { item_id: 2, item_built_by: 'core-1', item_status: 'withdrawn', item_withdrawn_reason: 'declined' }];
    const oldGone = { agent_id: 'core-1', path: tree.path, presence: 'gone', heartbeatAt: NOW - DAY };
    const exact = classifyMaintenanceTree(tree, { ...base, seats: [oldGone], items: closed });
    assert.equal(exact.kind, 'finished');
    assert.equal(exact.oldEnough, true);
    assert.equal(exact.inactiveSince, NOW - DAY);
    const recent = classifyMaintenanceTree(tree, { ...base, seats: [{ ...oldGone, heartbeatAt: NOW - DAY + 1 }], items: closed });
    assert.equal(recent.kind, 'active');
    const rollback = classifyMaintenanceTree(tree, { ...base, now: NOW - DAY - 1, seats: [oldGone], items: closed });
    assert.equal(rollback.kind, 'active');
    const noTimestamp = classifyMaintenanceTree(tree, { ...base, seats: [{ agent_id: 'core-1', path: tree.path, presence: 'gone', mtime: NOW - 10 * DAY }], items: closed });
    assert.equal(noTimestamp.kind, 'active');
    assert.equal(noTimestamp.reason, 'seat-age-unknown');
  });

  test('maintenance classification ages missing-seat trees only from the prior observation and distinguishes finished, orphaned and scratch [B3,I4,I16]', () => {
    const base = input();
    const first = classifyMaintenanceTree(base.tree, base);
    assert.equal(first.kind, 'orphaned');
    assert.equal(first.inactiveSince, NOW);
    assert.equal(first.oldEnough, false);
    const old = classifyMaintenanceTree(base.tree, { ...base, previous: { firstSeenAt: NOW - DAY } });
    assert.equal(old.kind, 'orphaned');
    assert.equal(old.oldEnough, true);
    const finished = classifyMaintenanceTree(base.tree, { ...base, seats: [{ agent_id: 'core-1', path: base.tree.path, presence: 'gone', createdAt: NOW - 2 * DAY }],
      items: [{ item_id: 9, item_built_by: 'core-1', item_status: 'withdrawn' }] });
    assert.equal(finished.kind, 'finished');
    const canonicalSeat = { agent_id: 'core-1', path: base.tree.path, presence: 'gone', agent_created_at: NOW - 1_000 };
    const secondsGrace = { ...base, config: { ...base.config, worktreeMaintenance: { ...base.config.worktreeMaintenance, grace: '1s' } },
      seats: [canonicalSeat], items: [{ item_id: 10, item_built_by: 'core-1', item_status: 'withdrawn' }] };
    assert.equal(classifyMaintenanceTree(base.tree, secondsGrace).kind, 'finished');
    assert.equal(classifyMaintenanceTree(base.tree, { ...secondsGrace, seats: [{ ...canonicalSeat, agent_created_at: NOW - 999 }] }).reason, 'seat-recent-or-clock-rollback');
    const millisecondsGrace = { ...base, config: { ...base.config, worktreeMaintenance: { ...base.config.worktreeMaintenance, grace: '250ms' } },
      seats: [{ ...canonicalSeat, agent_created_at: NOW - 250 }], items: secondsGrace.items };
    assert.equal(classifyMaintenanceTree(base.tree, millisecondsGrace).oldEnough, true);
    const scratch = classifyMaintenanceTree({ path: '/tmp/other/worktree', locked: false, bare: false }, { ...base, previous: { firstSeenAt: NOW - DAY } });
    assert.equal(scratch.kind, 'scratch');
    assert.equal(scratch.oldEnough, true);
    const futureFirstSeen = classifyMaintenanceTree(base.tree, { ...base, previous: { firstSeenAt: NOW + 1 } });
    assert.equal(futureFirstSeen.oldEnough, false);
  });

  test('native completed takeover ages retired live seats but claims and process directories still protect them [B3,I4,I16]', () => {
    const base = input();
    const seat = { agent_id: 'core-1', path: base.tree.path, presence: 'live',
      heartbeatAt: NOW - 2 * DAY, completedTakeoverAt: NOW - DAY };
    for (const presence of ['live', 'idle']) {
      const retired = classifyMaintenanceTree(base.tree, { ...base, seats: [{ ...seat, presence }] });
      assert.equal(retired.protected, false);
      assert.equal(retired.oldEnough, true);
    }
    const claimed = classifyMaintenanceTree(base.tree, { ...base, seats: [seat],
      items: [{ item_id: 81, item_owner: seat.agent_id, item_status: 'claimed' }] });
    assert.equal(claimed.protected, true);
    assert.equal(claimed.reason, 'claim');
    const inUse = classifyMaintenanceTree(base.tree, { ...base, seats: [seat],
      workingDirectories: [{ pid: 1234, path: join(base.tree.path, 'nested') }] });
    assert.equal(inUse.protected, true);
    assert.equal(inUse.reason, 'process-working-directory');
  });
}
