/** A linked worktree never prints the maintenance timer warning; a main checkout reports a real failure [B3,C7,#2909]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceGit } from '../apps/cli/src/shell/worktree-maintenance-archive.js';
import { scheduleWorktreeMaintenance } from '../apps/cli/src/shell/worktree-maintenance-scheduler.js';

/** A primary checkout with maintenance enabled, a stub timer binary and one linked worktree. */
function repository(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pullboard-timer-quiet-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = join(root, 'primary'), linked = join(root, 'linked');
  fs.mkdirSync(join(primary, 'bin'), { recursive: true });
  maintenanceGit(primary, ['init', '-q', '-b', 'main']);
  maintenanceGit(primary, ['config', 'user.name', 'Timer Fixture']);
  maintenanceGit(primary, ['config', 'user.email', 'timer@example.invalid']);
  fs.writeFileSync(join(primary, 'pullboard.json'), JSON.stringify({ worktreeMaintenance: { enabled: true } }));
  fs.writeFileSync(join(primary, 'bin', 'pullboard.js'), 'setTimeout(() => {}, 4000);\n');
  maintenanceGit(primary, ['add', '.']); maintenanceGit(primary, ['commit', '-qm', 'timer fixture']);
  maintenanceGit(primary, ['worktree', 'add', '-q', '--detach', linked]);
  const commonDir = fs.realpathSync(maintenanceGit(primary, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const config = { worktreeMaintenance: { enabled: true } };
  t.after(() => {
    try { process.kill(JSON.parse(fs.readFileSync(join(commonDir, 'pullboard', 'worktree-maintenance', 'timer.json'), 'utf8')).pid); }
    catch { /* No timer was registered. */ }
  });
  return { primary: { info: { root: fs.realpathSync(primary), commonDir, isMain: true }, config },
    linked: { info: { root: fs.realpathSync(linked), commonDir, isMain: false }, config }, commonDir };
}

/** Exercise scheduler behavior outside runner jobs, whose production policy intentionally skips detached timers. */
async function withoutRunnerJob(work) {
  const saved = process.env.PULLBOARD_RUNNER_JOB;
  delete process.env.PULLBOARD_RUNNER_JOB;
  try { return await work(); }
  finally { if (saved === undefined) delete process.env.PULLBOARD_RUNNER_JOB; else process.env.PULLBOARD_RUNNER_JOB = saved; }
}

test('clause 1: a linked worktree with an inherited GIT_DIR still registers the timer without an error [B3,C7]', async t => {
  await withoutRunnerJob(async () => {
    const { linked } = repository(t), saved = process.env.GIT_DIR;
    process.env.GIT_DIR = maintenanceGit(linked.info.root, ['rev-parse', '--absolute-git-dir']).trim();
    try {
      const result = await scheduleWorktreeMaintenance(linked);
      assert.equal(result.scheduled, true, 'the primary checkout is still found as the primary');
    } finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; }
  });
});

test('clause 1: a linked worktree skips quietly when the repository identity cannot be proved [B3,C7]', async t => {
  await withoutRunnerJob(async () => {
    const { linked, commonDir } = repository(t);
    linked.info = { ...linked.info, commonDir: join(commonDir, 'elsewhere') };
    fs.mkdirSync(linked.info.commonDir);
    assert.deepEqual(await scheduleWorktreeMaintenance(linked), { scheduled: false, reason: 'linked-worktree-unavailable' });
  });
});

test('clause 2: a real registration failure in the main checkout is still thrown once [B3,C7]', async t => {
  await withoutRunnerJob(async () => {
    const { primary, commonDir } = repository(t);
    primary.info = { ...primary.info, commonDir: join(commonDir, 'elsewhere') };
    fs.mkdirSync(primary.info.commonDir);
    await assert.rejects(() => scheduleWorktreeMaintenance(primary), error => error.maintenanceStage === 'lookup' && /repository changed/u.test(error.message));
  });
});
