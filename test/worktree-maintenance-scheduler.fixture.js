/** @pullboard-test-loads src/worktree-maintenance-scheduler.js */
/** @pullboard-test-loads bin/pullboard.js */
/** Repository timer ownership never borrows a seat or replaces unknown process custody [B3,C7,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import cp from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceGit } from '../src/worktree-maintenance-archive.js';
import { scheduleWorktreeMaintenance, runScheduledMaintenance } from '../src/worktree-maintenance-scheduler.js';

function project(t, enabled) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pullboard-timer-fixture-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  maintenanceGit(root, ['init', '-q', '-b', 'main']);
  maintenanceGit(root, ['config', 'user.name', 'Timer Fixture']);
  maintenanceGit(root, ['config', 'user.email', 'timer@example.invalid']);
  fs.writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ worktreeMaintenance: { enabled } }));
  maintenanceGit(root, ['add', '.']); maintenanceGit(root, ['commit', '-qm', 'timer fixture']);
  const commonDir = fs.realpathSync(maintenanceGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  return { info: { root, commonDir }, config: { worktreeMaintenance: { enabled: true } } };
}

export function registerMaintenanceSchedulerTests() {
  test('disabled maintenance scheduling and an unregistered watch key do no filesystem work [B3,C7,N26]', async () => {
    const ctx = { info: { root: '/nonexistent-maintenance-fixture', commonDir: '/nonexistent-maintenance-fixture/.git' }, config: { worktreeMaintenance: { enabled: false } } };
    assert.deepEqual(await scheduleWorktreeMaintenance(ctx), { scheduled: false, reason: 'disabled' });
    assert.deepEqual(await runScheduledMaintenance(ctx, 'not-a-native-token'), { ran: false, reason: 'unregistered' });
  });

  test('canonical committed main opt-out defeats a stale caller opt-in before timer creation [B3,C7,N26]', async t => {
    const ctx = project(t, false);
    assert.deepEqual(await scheduleWorktreeMaintenance(ctx), { scheduled: false, reason: 'disabled-on-main' });
    assert.equal(fs.existsSync(join(ctx.info.commonDir, 'pullboard', 'worktree-maintenance')), false);
  });

  test('native live and unknown timer process observations retain exact registration without another child [B3,C7,N26]', async t => {
    const ctx = project(t, true), directory = join(ctx.info.commonDir, 'pullboard', 'worktree-maintenance');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(directory, 'timer.guard.sqlite'), '', { mode: 0o600 });
    const started = cp.execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='],
      { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } }).trim();
    const owner = { version: 1, token: randomUUID(), pid: process.pid, started,
      dueAt: new Date(Date.now() + 3_600_000).toISOString(), root: ctx.info.root, common: ctx.info.commonDir };
    const file = join(directory, 'timer.json'), bytes = JSON.stringify(owner) + '\n';
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    assert.equal((await scheduleWorktreeMaintenance(ctx)).reason, 'existing-timer');
    const original = cp.execFileSync; let observations = 0;
    cp.execFileSync = function(command, ...args) {
      if (command === '/bin/ps') { observations++; throw Object.assign(new Error('private observation denied'), { code: 'EPERM' }); }
      return original.call(this, command, ...args);
    };
    syncBuiltinESMExports();
    try { assert.equal((await scheduleWorktreeMaintenance(ctx)).reason, 'existing-timer'); }
    finally { cp.execFileSync = original; syncBuiltinESMExports(); }
    assert.ok(observations > 0, 'the real process observer exercised unknown status');
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(fs.existsSync(join(directory, 'scheduler.log')), false, 'no second worker was launched');
  });
}
