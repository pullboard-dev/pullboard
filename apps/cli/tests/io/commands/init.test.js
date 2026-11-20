/** @pullboard-test-input source-cell apps/cli */
/** pullboard init registers the repo it manages for git maintenance and schedules it through git's own --scheduler; no test touches the real scheduler [C7,#10782]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../fixtures/init/ignore-box.js';
import { scheduleGitMaintenance } from '../../../src/io/init/git-maintenance.js';

/** The command git runs for each --scheduler choice. */
const COMMAND = { launchctl: 'launchctl', schtasks: 'schtasks', 'systemd-timer': 'systemctl', crontab: 'crontab' };

/**
 * Fake scheduler commands that log their arguments, wired through git's own GIT_TEST_MAINT_SCHEDULER hook, so git
 * believes exactly these schedulers exist and never runs the real launchctl, schtasks, systemctl or crontab.
 */
function fakeSchedulers(dir, commands, tag) {
  const log = join(dir, `${tag}.log`);
  writeFileSync(log, '');
  const pairs = commands.map(command => {
    const path = join(dir, `${tag}-${command}`);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "${command} $*" >> '${log}'\n`);
    chmodSync(path, 0o755);
    return `${command}:${path}`;
  });
  return { spec: pairs.length ? pairs.join(',') : 'none:none', log };
}

/** An init fixture whose git keeps its global config, home and scheduler files inside the fixture, with these fake schedulers. */
function maintenanceBox(t, commands) {
  const box = fixture(t);
  const dir = dirname(box.root);
  const global = join(dir, 'global.gitconfig');
  writeFileSync(global, '');
  mkdirSync(box.env.HOME, { recursive: true });
  const fakes = fakeSchedulers(dir, commands, 'init');
  Object.assign(box.env, { GIT_CONFIG_GLOBAL: global, XDG_CONFIG_HOME: join(dir, 'xdg'), GIT_TEST_MAINT_SCHEDULER: fakes.spec });
  const config = (...args) => spawnSync('git', ['config', ...args], { cwd: box.root, env: box.env, encoding: 'utf8' }).stdout.trim();
  return { ...box, dir, log: fakes.log, config };
}

/** The maintenance outcome inside an init JSON document, wherever the envelope puts it. */
function maintenanceOf(document) {
  if (!document || typeof document !== 'object') return undefined;
  if (document.maintenance && typeof document.maintenance === 'object' && 'state' in document.maintenance) return document.maintenance;
  for (const value of Object.values(document)) {
    const found = maintenanceOf(value);
    if (found) return found;
  }
  return undefined;
}

test('cli.io-commands-init.registers-incremental-maintenance: clause 1: init on a fresh repository registers it for git maintenance with the incremental strategy and prefetch off, and schedules it with git\'s own scheduler choice [C7,#10782]', async t => {
  const box = maintenanceBox(t, Object.values(COMMAND));
  const ran = await box.invoke('init');
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(maintenanceOf(ran.document), { state: 'scheduled', scheduler: 'auto' });
  assert.deepEqual(box.config('--global', '--get-all', 'maintenance.repo').split('\n'), [realpathSync(box.root)]);
  assert.equal(box.config('--local', 'maintenance.strategy'), 'incremental');
  assert.equal(box.config('--local', 'maintenance.prefetch.enabled'), 'false');
  assert.equal(box.config('--local', 'maintenance.auto'), 'false');
  const calls = readFileSync(box.log, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(calls.length > 0, 'git ran the scheduler it chose, here a fake');
  assert.ok(calls.every(line => Object.values(COMMAND).some(command => line.startsWith(`${command} `))), calls.join('\n'));
});

test('cli.io-commands-init.each-platform-uses-its-git-scheduler: clause 1: the macOS, Windows and Linux schedulers (launchctl, schtasks, a systemd timer, cron) each schedule the repo through git maintenance start --scheduler [C7,#10782]', t => {
  const box = maintenanceBox(t, []);
  for (const [scheduler, command] of Object.entries(COMMAND)) {
    const fakes = fakeSchedulers(box.dir, [command], `case-${command}`);
    const outcome = scheduleGitMaintenance(box.root, { scheduler, env: { ...box.env, GIT_TEST_MAINT_SCHEDULER: fakes.spec } });
    assert.deepEqual(outcome, { state: 'scheduled', scheduler });
    const calls = readFileSync(fakes.log, 'utf8').trim().split('\n');
    assert.ok(calls.some(line => line.startsWith(`${command} `)), `git ran ${command}: ${calls.join(' | ')}`);
  }
});

test('cli.io-commands-init.no-scheduler-records-unscheduled: clause 2: init on a machine with no supported scheduler records that maintenance is not scheduled, says how to run it by hand, and still succeeds [C7,#10782]', async t => {
  const box = maintenanceBox(t, []);
  const ran = await box.invoke('init');
  assert.equal(ran.code, 0, ran.stderr);
  const outcome = maintenanceOf(ran.document);
  assert.equal(outcome?.state, 'unscheduled', JSON.stringify(ran.document));
  assert.match(outcome.reason, /available/u);
  assert.equal(outcome.byHand, `git -C "${box.root}" maintenance run --schedule=daily`);
  assert.equal(box.config('--global', '--get-all', 'maintenance.repo'), realpathSync(box.root), 'the repo is still registered');
  const said = await box.output('init');
  assert.equal(said.code, 0, said.stderr);
  assert.match(said.stdout, /git maintenance is not scheduled on this machine .*; run it by hand: git -C ".+" maintenance run --schedule=daily/u);
});

test('cli.io-commands-init.runner-job-never-schedules: clause 2: a runner job without git\'s test scheduler, or git with no global config, never runs git maintenance start [C7,#10782]', t => {
  const box = maintenanceBox(t, []);
  const calls = [];
  const git = (root, args, env) => {
    calls.push(args.join(' '));
    const ran = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    return { status: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: (ran.stderr ?? '').trim() };
  };
  const job = { ...box.env, PULLBOARD_RUNNER_JOB: 'job' };
  delete job.GIT_TEST_MAINT_SCHEDULER;
  const outcome = scheduleGitMaintenance(box.root, { env: job, git });
  assert.equal(outcome.state, 'unscheduled');
  assert.ok(calls.includes('maintenance register'), calls.join(' | '));
  assert.ok(!calls.some(call => call.startsWith('maintenance start')), calls.join(' | '));
  calls.length = 0;
  assert.deepEqual(scheduleGitMaintenance(box.root, { env: { ...box.env, GIT_CONFIG_GLOBAL: '/dev/null' }, git }), { state: 'off', reason: 'git has no global config here' });
  assert.deepEqual(calls, []);
});
