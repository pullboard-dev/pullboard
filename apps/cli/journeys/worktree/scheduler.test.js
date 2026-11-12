/** @pullboard-test-loads apps/cli/pullboard.js */
/** Timer diagnostics preserve native scheduling and report actual failures [B3,C7,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { registerMaintenanceSchedulerTests } from '../../tests/fixtures/worktree/maintenance/scheduler.js';
import { maintenanceTimerHealth } from '../../src/io/worktree/maintenance/scheduler.js';

// These tests start maintenance or tool-build timers on purpose; they opt out of the runner job's no-timer marker (#2513).
delete process.env.PULLBOARD_RUNNER_JOB;
registerMaintenanceSchedulerTests();

/** Enable accepted maintenance only after the fixture's ordinary initialization and commits. */
function enabledProject(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', undefined, { withWorktree: false });
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.worktreeMaintenance = { enabled: true, every: '1h', grace: '1d', exclude: [] };
  writeFileSync(file, JSON.stringify(config));
  box.git(box.repo, 'add', '.');
  box.git(box.repo, 'commit', '-qm', 'test: enable private timer');
  const common = box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const directory = join(common, 'pullboard', 'worktree-maintenance');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { box, common, directory };
}

test('actual CLI registration failure prints stage and cause without changing its successful result [B3,C7,N26]', async t => {
  const { box, directory } = enabledProject(t);
  writeFileSync(join(directory, 'timer.guard.sqlite'), '', { mode: 0o644 });
  chmodSync(join(directory, 'timer.guard.sqlite'), 0o644); // the executing host's umask would otherwise narrow the mode written above
  const result = (await box.runLocal(box.repo, 'status'));
  assert.equal(result.code, 0, result.err || result.out);
  assert.match(result.err, /maintenance timer could not be registered; stage=register; Error: maintenance timer lock is not private/u);
  assert.equal(readFileSync(join(directory, 'timer.guard.sqlite'), 'utf8'), '', 'diagnostics never repair or retry the failed registration');
});

test('actual CLI keeps a live timer silently and health names its exact key pid and recorded last run [B3,C7,N26]', async t => {
  const { box, common, directory } = enabledProject(t);
  writeFileSync(join(directory, 'timer.guard.sqlite'), '', { mode: 0o600 });
  const started = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='],
    { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } }).trim().split(/\s+/u).join(' ');
  const owner = { version: 1, token: randomUUID(), pid: process.pid, started,
    dueAt: new Date(Date.now() + 3_600_000).toISOString(), root: box.repo, common };
  const key = createHash('sha256').update(owner.token).digest('hex');
  const bytes = JSON.stringify(owner) + '\n';
  writeFileSync(join(directory, 'timer.json'), bytes, { mode: 0o600 });
  assert.equal(maintenanceTimerHealth(common).lastRun, null, 'absence of a recorded run is unknown, not a fabricated completion');
  const completed = (await box.runLocal(box.repo, 'maintenance'));
  assert.equal(completed.code, 0, completed.err || completed.out);
  const result = (await box.runLocal(box.repo, 'status'));
  assert.equal(result.code, 0, result.err || result.out);
  assert.doesNotMatch(result.err, /maintenance timer/u);
  assert.equal(readFileSync(join(directory, 'timer.json'), 'utf8'), bytes);
  const observed = maintenanceTimerHealth(common);
  assert.equal(observed.state, 'live');
  assert.equal(observed.key, key);
  assert.equal(observed.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(observed.lastRun.completedAt)));
  const health = (await box.runLocal(box.repo, 'health', '--json'));
  const document = JSON.parse(health.out);
  assert.equal(document.maintenanceTimer.key, key);
  assert.ok(!health.out.includes(owner.token), 'the private watch token never appears in health output');
  assert.equal(document.maintenanceTimer.pid, process.pid);
  assert.equal(document.maintenanceTimer.lastRun.completedAt, observed.lastRun.completedAt);
  assert.doesNotMatch(health.err, /maintenance timer/u);
});
