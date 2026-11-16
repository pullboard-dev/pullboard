/** @pullboard-test-loads apps/cli/src/io/worktree/maintenance.js apps/cli/src/io/worktree/maintenance/idle-seats.js */
/** maintenance.retireIdleSeats retires a clean, idle seat worktree whose HEAD is on main, and nothing else [C7,#9109]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runWorktreeMaintenance } from '../../../../src/io/worktree/maintenance.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { fixtureMachineSettings } from '../../../../../../packages/gate/tests/fixtures/testkit.js';
import { settingsInventory } from '../../../../../../packages/config/index.js';

const HOUR = 3_600_000;

/** A real repository on main plus one detached seat worktree per name, all outside the repository, with machine settings given. */
function fixture(t, settings) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }), { withWorktree: false });
  const { repo } = box, home = box.env.PULLBOARD_MACHINE_HOME;
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, settings);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const git = (cwd, ...args) => box.git(cwd, ...args);
  const seat = name => { const path = join(box.dir, name); git(repo, 'worktree', 'add', '-q', '--detach', path, 'main'); return path; };
  /** Make everything the engine reads from the tree look last touched at `at`. */
  const touch = (path, at) => {
    const gitDir = String(git(path, 'rev-parse', '--absolute-git-dir')).trim(), when = new Date(at);
    for (const file of [path, gitDir, join(gitDir, 'index'), join(gitDir, 'HEAD')]) if (existsSync(file)) utimesSync(file, when, when);
  };
  const ports = { agentId: 'coordinator', readSnapshot: async () => ({ seats: [], items: [] }), workingDirectories: () => [],
    archiveVolume: () => ({ freeBytes: 900 * 2 ** 30, totalBytes: 1000 * 2 ** 30 }) };
  const config = { worktrees: 'beside', worktreeMaintenance: { enabled: true, every: '1h', grace: '1d', exclude: [] } };
  return { repo, git, seat, touch, run: now => runWorktreeMaintenance(repo, config, ports, { now }) };
}

test('clause 1: with maintenance.retireIdleSeats on, a clean seat idle past the set age with HEAD on main is removed [C7,#9109]', async t => {
  const fx = fixture(t, { maintenance: { retireIdleSeats: true } });
  const now = Date.now() + 10 * HOUR, idle = fx.seat('b-idle');
  fx.touch(idle, now - 4 * HOUR);
  const report = await fx.run(now);
  assert.equal(existsSync(idle), false, 'the idle clean seat is gone');
  assert.equal(report.entries.find(row => row.path === idle).action, 'retired-idle');
  assert.equal(report.pruned, 1);
  assert.doesNotMatch(fx.git(fx.repo, 'worktree', 'list'), /b-idle/u, 'Git no longer lists it');
  assert.equal(existsSync(fx.repo), true, 'the main checkout stays');
});

test('clause 2: it keeps a dirty, locked, recent or off-main worktree [C7,#9109]', async t => {
  const fx = fixture(t, { maintenance: { retireIdleSeats: true } });
  const now = Date.now() + 10 * HOUR, old = now - 4 * HOUR;
  const dirty = fx.seat('b-dirty'), locked = fx.seat('b-locked'), recent = fx.seat('b-recent'), ahead = fx.seat('b-ahead');
  writeFileSync(join(dirty, 'scratch.txt'), 'unfinished\n');
  fx.git(locked, 'worktree', 'lock', locked);
  writeFileSync(join(ahead, 'b.txt'), 'b\n'); fx.git(ahead, 'add', '.'); fx.git(ahead, 'commit', '-q', '-m', 'ahead of main');
  for (const path of [dirty, locked, ahead]) fx.touch(path, old);
  fx.touch(recent, now - HOUR);
  const report = await fx.run(now);
  for (const path of [dirty, locked, recent, ahead]) assert.equal(existsSync(path), true, `${path} is kept`);
  assert.equal(report.pruned, 0);
});

test('clause 2: with maintenance.retireIdleSeats off, the default, maintenance removes nothing [C7,#9109]', async t => {
  const fx = fixture(t, {});
  const now = Date.now() + 10 * HOUR, idle = fx.seat('b-idle');
  fx.touch(idle, now - 4 * HOUR);
  const report = await fx.run(now);
  assert.equal(existsSync(idle), true);
  assert.equal(report.pruned, 0);
});

test('clause 3: maintenance.retireIdleSeats is a described setting, off by default [C7,#9109]', t => {
  const fx = fixture(t, {});
  const row = settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'maintenance.retireIdleSeats');
  assert.equal(row.default, false);
  assert.equal(row.value, false);
  assert.ok(row.label && /untouched/u.test(row.description ?? JSON.stringify(row)), 'the row carries a plain label and description');
});
