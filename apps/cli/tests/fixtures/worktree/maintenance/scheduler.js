/** @pullboard-test-loads apps/cli/src/io/worktree/maintenance/scheduler.js */
/** @pullboard-test-loads apps/cli/pullboard.js */
/** @pullboard-test-input apps/cli/src/io/worktree/maintenance/scheduler.js */
/** Repository timer ownership never borrows a seat or replaces unknown process custody [B3,C7,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import cp from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createE2eHelpers } from '../../e2e.js';
import { copyCommittedPackageFiles } from '../../copy.js';
import { privateFixtureFiles } from '../../child.js';
import { runFixtureChild } from '../../child.js';
import { isolateTestMachine } from '../../../../../../packages/gate/index.js';
import { processCensus } from '../../../../../runner/index.js';
import { maintenanceGit } from '../../../../src/io/worktree/maintenance/archive.js';
import { scheduleWorktreeMaintenance } from '../../../../src/io/worktree/maintenance/scheduler.js';
import { runScheduledMaintenance } from '../../../../src/io/worktree/maintenance/scheduler.js';

const FIXTURE_CONFIG = {
  gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', landing: { manualOverride: true },
  lanes: { web: { owns: ['web/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } },
  shared: ['docs/'],
};
const FIXTURE_SPEC = `# Demo spec

## G · Goals
- G1 [approved, must] The page renders. | gate: web test
- G2 [approved, must] The API answers. | gate: api test
`;

/** Copy and commit the shipped runtime before init installs hooks in this private repo. */
function projectWithCommittedRuntime(sandbox) {
  const repo = join(sandbox.dir, 'repo');
  fs.mkdirSync(repo);
  sandbox.git(repo, 'init', '-q', '-b', 'main');
  const box = { ...sandbox, repo };
  copyCommittedPackageFiles(box, resolve(import.meta.dirname, '../../../../../..'));
  const inheritedModel = sandbox.env.PULLBOARD_MODEL;
  delete sandbox.env.PULLBOARD_MODEL;
  const initialized = sandbox.run(repo, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  sandbox.git(repo, 'config', 'user.name', 'Test Agent');
  sandbox.git(repo, 'config', 'user.email', 'agent@example.com');
  if (inheritedModel !== undefined) sandbox.env.PULLBOARD_MODEL = inheritedModel;
  fs.writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(FIXTURE_CONFIG, null, 2));
  fs.writeFileSync(join(repo, 'SPEC.md'), FIXTURE_SPEC);
  sandbox.git(repo, 'add', '-A');
  sandbox.git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  return box;
}

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
  test('a private shipped CLI timer wakes once, preserves one owner and obeys canonical opt-out [B3,C7,N26, clause 1]', { timeout: 120_000 }, async t => {
    const helpers = createE2eHelpers(), sandbox = helpers.sandbox();
    sandbox.env.PULLBOARD_MODEL = 'Test Model';
    isolateTestMachine(sandbox.env, sandbox.dir);
    sandbox.env.PULLBOARD_BACKGROUND_VIEW = '0';
    sandbox.env.PULLBOARD_BACKGROUND_RELAY = '0';
    const box = projectWithCommittedRuntime(sandbox);
    const common = fs.realpathSync(box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim());
    const directory = join(common, 'pullboard', 'worktree-maintenance'), marker = join(directory, 'timer.json');
    const configFile = join(box.repo, 'pullboard.json'), owned = new Map();
    const key = row => `${row.pid}:${row.started}`;
    function observe() {
      const observation = processCensus();
      if (!observation) throw new Error('private scheduler census unavailable');
      const census = [...observation.values()];
      let owner;
      try { owner = JSON.parse(fs.readFileSync(marker, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (owner?.root === box.repo && owner.common === common) {
        const row = census.find(row => row.pid === owner.pid && row.started === owner.started);
        if (row) owned.set(key(row), row);
      }
      // Only adopt descendants while their exact already-owned parent is observed alive.
      let changed;
      do {
        changed = false;
        for (const row of census) if (!owned.has(key(row)) && census.some(parent => parent.pid === row.ppid && owned.has(key(parent)))) {
          owned.set(key(row), row); changed = true;
        }
      } while (changed);
      return { census, owner };
    }
    function policy(enabled) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.worktreeMaintenance?.enabled === enabled && config.worktreeMaintenance.every === '20s') return;
      config.worktreeMaintenance = { enabled, every: '20s', grace: '1d', exclude: [] };
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
      box.git(box.repo, 'add', 'pullboard.json');
      box.git(box.repo, 'commit', '-qm', `test: ${enabled ? 'enable' : 'disable'} private maintenance timer`);
    }
    t.after(async () => {
      // Opt out through accepted private main before stopping only exact native-owned identities.
      policy(false);
      observe();
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        const { census } = observe();
        for (const row of census) if (owned.has(key(row))) {
          try { process.kill(row.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        await pause(100);
      }
      const { census } = observe();
      assert.equal(census.some(row => owned.has(key(row)) && !row.state?.startsWith('Z')), false, 'owned timer children have stopped');
      helpers.cleanup();
    });
    policy(true);
    const scheduler = pathToFileURL(join(box.repo, 'apps/cli/src/io/worktree/maintenance/scheduler.js')).href;
    const ctx = { info: { root: box.repo, commonDir: common }, config: { worktreeMaintenance: { enabled: true } } };
    const program = `import {scheduleWorktreeMaintenance} from ${JSON.stringify(scheduler)};
`
      + `const ctx=${JSON.stringify(ctx)}; await scheduleWorktreeMaintenance(ctx); await scheduleWorktreeMaintenance(ctx);`;
    const launched = runFixtureChild(process.execPath, ['--input-type=module', '-e', program],
      { cwd: box.repo, env: box.env, encoding: 'utf8' });
    assert.equal(launched.status, 0, launched.failure ?? launched.stderr);
    const first = observe().owner;
    assert.ok(first && owned.size > 0, 'actual native timer PID/start is observable');
    await pause(100);
    assert.deepEqual(observe().owner, first, 'repeated scheduling retains exact registration');
    const deadline = Date.now() + 75_000;
    let report;
    while (Date.now() < deadline) {
      observe();
      try { report = JSON.parse(fs.readFileSync(join(directory, 'state.json'), 'utf8')).lastRun; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (report?.finishedAt && fs.existsSync(join(directory, 'scheduler.log'))
        && fs.readFileSync(join(directory, 'scheduler.log'), 'utf8').split('\n').some(line => line.startsWith('maintenance:'))) break;
      await pause(50);
    }
    assert.ok(report?.finishedAt, 'fresh shipped maintenance CLI completed an actual scheduled wake');
    assert.equal(report.enabled, true);
    policy(false);
    const log = fs.readFileSync(join(directory, 'scheduler.log'), 'utf8');
    assert.equal(log.split('\n').filter(line => line.startsWith('maintenance:')).length, 1, log);
    const disabled = runFixtureChild(process.execPath, ['--input-type=module', '-e',
      `import {scheduleWorktreeMaintenance} from ${JSON.stringify(scheduler)}; console.log(JSON.stringify(await scheduleWorktreeMaintenance(${JSON.stringify(ctx)})));`],
    { cwd: box.repo, env: box.env, encoding: 'utf8' });
    assert.equal(disabled.status, 0, disabled.failure ?? disabled.stderr);
    assert.match(disabled.stdout, /disabled-on-main/u, 'fresh canonical opt-out defeats the stale enabled caller');
  });

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

  test('clause 1: scheduling a timer asks Git for no worktree list when the common directory is the primary .git [C7]', async t => {
    const ctx = project(t, true), shim = privateFixtureFiles('pullboard-git-shim-').root, log = join(shim, 'calls.log');
    t.after(() => fs.rmSync(shim, { recursive: true, force: true }));
    const real = cp.execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(join(shim, 'git'), `#!/bin/sh\necho "$@" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    const directory = join(ctx.info.commonDir, 'pullboard', 'worktree-maintenance');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(directory, 'timer.guard.sqlite'), '', { mode: 0o600 });
    const started = cp.execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='],
      { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } }).trim().split(/\s+/u).join(' ');
    fs.writeFileSync(join(directory, 'timer.json'), JSON.stringify({ version: 1, token: randomUUID(), pid: process.pid, started,
      dueAt: new Date(Date.now() + 3_600_000).toISOString(), root: ctx.info.root, common: ctx.info.commonDir }) + '\n', { mode: 0o600 });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try {
      assert.equal((await scheduleWorktreeMaintenance(ctx)).reason, 'existing-timer');
      assert.equal((await scheduleWorktreeMaintenance(ctx)).reason, 'existing-timer');
    } finally { process.env.PATH = path; }
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    assert.ok(calls.length > 0, 'the shim saw the scheduler run Git');
    assert.doesNotMatch(calls, /worktree list/u, 'no worktree list ran');
  });

  test('native live and unknown timer process observations retain exact registration without another child [B3,C7,N26]', async t => {
    const ctx = project(t, true), directory = join(ctx.info.commonDir, 'pullboard', 'worktree-maintenance');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(directory, 'timer.guard.sqlite'), '', { mode: 0o600 });
    const started = cp.execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
      encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
    }).trim().split(/\s+/u).join(' ');
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
