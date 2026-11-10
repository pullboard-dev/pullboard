/** @pullboard-test-loads packages/config/src/io/main.js */
/** @pullboard-test-loads packages/config/src/logic/maintenance.js */
/** Maintenance remains opt-in and invalid known coordinator settings never become cleanup authority [B3,C7,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../src/io/main.js';
import { maintenanceDefaults } from '../../src/logic/maintenance.js';
import { maintenanceConfigProblems } from '../../src/logic/maintenance.js';
import { maintenanceDurations } from '../../src/logic/maintenance.js';
import { describeSetting } from '../../src/io/settings/descriptions.js';

export function registerMaintenanceConfigTests() {
  test('worktree maintenance defaults off with a fresh exclusion list and preserves legacy placement [B3,C7,N26]', () => {
    const first = maintenanceDefaults(), second = maintenanceDefaults();
    assert.deepEqual(first, { enabled: false, every: '1h', grace: '1d', exclude: [] });
    first.exclude.push('/fixture/never-clean');
    assert.deepEqual(second.exclude, []);
    const config = configFromSource('{}');
    assert.deepEqual(config.worktreeMaintenance, second);
    assert.equal(config.worktrees, 'beside');
    assert.deepEqual(maintenanceDurations(second), { everyMs: 3_600_000, graceMs: 86_400_000 });
  });

  test('partial maintenance config merges defaults and keeps explicit exclusions without filesystem access [B3,C7,N26]', () => {
    const exclude = ['/private/fixture/keep', '/another/nonexistent/worktree'];
    const config = configFromSource(JSON.stringify({ worktrees: 'inside', worktreeMaintenance: { enabled: true, every: '90m', exclude } }));
    assert.deepEqual(config.worktreeMaintenance, { enabled: true, every: '90m', grace: '1d', exclude });
    assert.equal(config.worktrees, 'inside');
    assert.deepEqual(maintenanceDurations(config.worktreeMaintenance), { everyMs: 5_400_000, graceMs: 86_400_000 });
    for (const key of ['enabled', 'every', 'grace', 'exclude']) {
      const description = describeSetting('worktreeMaintenance.' + key);
      assert.ok(description.label && description.description && description.group && description.unit);
    }
  });

  test('maintenance known types durations paths and own-property schema stay strict [B3,C7,N26]', () => {
    const base = maintenanceDefaults();
    for (const enabled of [null, 'true', 0, [], {}]) {
      assert.ok(maintenanceConfigProblems({ ...base, enabled }).length);
      assert.throws(() => configFromSource(JSON.stringify({ worktreeMaintenance: { enabled } })), { code: 'BAD_CONFIG' });
    }
    for (const key of ['every', 'grace']) for (const value of ['0ms', '0h', '-1h', '1.5h', 'forever', '25d', '2147483648ms', 1, null]) {
      const raw = { ...base, [key]: value };
      assert.ok(maintenanceConfigProblems(raw).length, `${key} ${value}`);
      assert.throws(() => maintenanceDurations(raw), TypeError);
      assert.throws(() => configFromSource(JSON.stringify({ worktreeMaintenance: raw })), { code: 'BAD_CONFIG' });
    }
    for (const exclude of ['off', [1], ['relative/path'], ['/path\nwith-control'], ['/trailing-space ']]) {
      assert.ok(maintenanceConfigProblems({ ...base, exclude }).length);
      assert.throws(() => configFromSource(JSON.stringify({ worktreeMaintenance: { exclude } })), { code: 'BAD_CONFIG' });
    }
    for (const value of [null, [], true]) assert.throws(() => configFromSource(JSON.stringify({ worktreeMaintenance: value })), { code: 'BAD_CONFIG' });
    assert.ok(maintenanceConfigProblems({ ...base, unknown: true }).length, 'direct known schema remains closed');
    assert.ok(maintenanceConfigProblems(Object.create(base)).length, 'inherited fields are not a declaration');
    for (const every of ['1ms', '1s', '1m', '1h', '1d', '2147483647ms']) assert.deepEqual(maintenanceConfigProblems({ ...base, every }), []);
  });
}
