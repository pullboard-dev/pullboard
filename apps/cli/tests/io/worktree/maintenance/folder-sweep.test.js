/** @pullboard-test-loads apps/cli/src/io/worktree/maintenance.js apps/cli/src/io/worktree/maintenance/folder-sweep.js */
/** One maintenance sweep removes clean folders of landed, withdrawn and dead-seat items inside the grace; dirty ones keep their diff at a keep ref [C7,#12537]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runWorktreeMaintenance } from '../../../../src/io/worktree/maintenance.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { fixtureMachineSettings } from '../../../../../../packages/gate/tests/fixtures/testkit.js';

/** A real repository on main, seat worktrees and branch item folders beside it, and a board snapshot the test edits. */
function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }), { withWorktree: false });
  const { repo } = box, home = box.env.PULLBOARD_MACHINE_HOME;
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, {});
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const git = (cwd, ...args) => String(box.git(cwd, ...args));
  // The line's takeover window is 30 minutes, so a seat silent for 40 minutes is idle past it but inside the 1-day grace.
  const board = { seats: [], items: [], takeoverMs: 30 * 60_000 };
  const recent = new Date(Date.now() - 40 * 60_000).toISOString();
  /** Join a seat: a detached worktree at main with a seat row of the given presence and a heartbeat inside the grace. */
  const seat = (name, agent, presence) => {
    const path = join(box.dir, name);
    git(repo, 'worktree', 'add', '-q', '--detach', path, 'main');
    board.seats.push({ agent_id: agent, agent_path: path, presence, heartbeatAt: recent });
    return path;
  };
  /** Open an item folder on its own branch with one commit of work, as claim does. */
  const itemFolder = (path, id) => {
    git(repo, 'worktree', 'add', '-q', '-b', `core/item-${id}`, path, 'main');
    writeFileSync(join(path, `item-${id}.txt`), 'work\n');
    git(path, 'add', '.');
    const tree = git(path, 'write-tree').trim();
    const commit = git(path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', 'HEAD', '-m', `item ${id}`).trim();
    git(path, 'update-ref', 'HEAD', commit);
    return { path, commit };
  };
  const events = [];
  const ports = { agentId: 'coordinator', readSnapshot: async () => structuredClone(board), workingDirectories: () => [],
    recordDirty: async () => {}, recordSweep: async record => { events.push(record); },
    archiveVolume: () => ({ freeBytes: 900 * 2 ** 30, totalBytes: 1000 * 2 ** 30 }) };
  const config = { worktrees: 'beside', worktreeMaintenance: { enabled: true, every: '1h', grace: '1d', exclude: [] } };
  const landed = (id, commit, by) => ({ item_id: id, item_status: 'verified', item_owner: null, item_built_by: by, item_commit: commit, item_merged_commit: 'f'.repeat(40) });
  return { repo, git, board, seat, itemFolder, events, landed, run: () => runWorktreeMaintenance(repo, config, ports, { now: Date.now() }) };
}

test('cli.io-worktree-maintenance-folder-sweep.landed-clean-gone-dirty-kept-claim-untouched: clause 1: one sweep removes a landed item\'s clean folder and logs rule item-closed, keeps a dirty landed folder with its diff at refs/pullboard/keep/<id>, and leaves a live claim\'s folder untouched [C7,#12537]', async t => {
  const fx = fixture(t);
  const builder = fx.seat('b-live', 'core-1', 'live'), other = fx.seat('b-other', 'core-2', 'live');
  const clean = fx.itemFolder(`${builder}-item-7`, 7), dirty = fx.itemFolder(`${builder}-item-8`, 8), held = fx.itemFolder(`${other}-item-9`, 9);
  fx.board.items.push(fx.landed(7, clean.commit, 'core-1'), fx.landed(8, dirty.commit, 'core-1'),
    { item_id: 9, item_status: 'claimed', item_owner: 'core-2', item_lease_until: new Date(Date.now() + 3_600_000).toISOString() });
  writeFileSync(join(dirty.path, 'unsaved.txt'), 'unfinished\n');
  const report = await fx.run();
  const row = path => report.entries.find(entry => entry.path === path);
  assert.equal(existsSync(clean.path), false, `the landed item's clean folder is gone: ${row(clean.path)?.reason}`);
  assert.equal(row(clean.path).action, 'swept');
  assert.doesNotMatch(fx.git(fx.repo, 'worktree', 'list'), /b-live-item-7/u, 'Git no longer lists it');
  assert.deepEqual(fx.events.find(event => event.path === clean.path), { action: 'removed', rule: 'item-closed', path: clean.path, item: 7, ref: null });
  assert.equal(existsSync(join(dirty.path, 'unsaved.txt')), true, 'the dirty folder and its work stay');
  const kept = fx.events.find(event => event.path === dirty.path);
  assert.equal(kept.action, 'kept');
  assert.equal(kept.rule, 'item-closed');
  assert.equal(kept.ref, 'refs/pullboard/keep/8');
  assert.equal(fx.git(fx.repo, 'show', 'refs/pullboard/keep/8:unsaved.txt').trim(), 'unfinished', 'the untracked file is in the keep ref');
  assert.equal(existsSync(held.path), true, 'a live claim keeps its folder');
  assert.equal(row(held.path).action, 'kept');
  assert.equal(existsSync(builder), true, 'a live seat keeps its own folder');
});

test('cli.io-worktree-maintenance-folder-sweep.dead-seat-and-agent-tree-swept: clause 2: a clean seat folder of a seat idle past the takeover window and holding nothing is removed inside the grace by rule dead-seat, an agent tree on a landed item branch goes by rule item-closed, and a gone seat holding a submitted item stays [C7,#12537]', async t => {
  const fx = fixture(t);
  const dead = fx.seat('b-dead', 'core-3', 'gone'), waiting = fx.seat('b-waiting', 'core-4', 'gone');
  const agent = fx.itemFolder(join(fx.repo, '.claude', 'worktrees', 'agent-11'), 11);
  fx.board.items.push(fx.landed(11, agent.commit, null), { item_id: 12, item_status: 'submitted', item_owner: null, item_built_by: 'core-4' });
  const report = await fx.run();
  const row = path => report.entries.find(entry => entry.path === path);
  assert.equal(existsSync(dead), false, `the gone seat's clean folder is removed inside the 1-day grace: ${row(dead)?.reason}`);
  assert.equal(fx.events.find(event => event.path === dead).rule, 'dead-seat');
  assert.equal(existsSync(agent.path), false, `the agent tree on a landed item branch is removed: ${row(agent.path)?.reason}`);
  assert.equal(fx.events.find(event => event.path === agent.path).rule, 'item-closed');
  assert.match(fx.git(fx.repo, 'branch', '--list', 'core/item-11'), /core\/item-11/u, 'the item branch stays');
  assert.equal(existsSync(waiting), true, 'a seat holding a submitted item keeps its folder');
  assert.equal(row(waiting).action, 'kept');
});
