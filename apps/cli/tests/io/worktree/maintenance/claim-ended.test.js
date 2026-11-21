/** @pullboard-test-loads apps/cli/src/io/worktree/maintenance.js apps/cli/src/io/worktree/maintenance/claim-ended.js apps/cli/src/io/worktree/maintenance/command.js */
/** The clock's folder row: an item folder is owned by its claim; one sweep removes it once the claim is released or lapsed, keeping a dirty diff at a board ref first [B5,C7,#12530]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { apiBoardOpeners } from '../../../fixtures/board.js';
import { openKitBoard } from '../../../fixtures/board.js';
import { addFixtureItem } from '../../../fixtures/worktree/maintenance/lifecycle.js';
import { joinAgent } from '../../../fixtures/worktree/maintenance/lifecycle.js';
import { context } from '../../../../src/io/context.js';
import { maintenanceCommandPorts } from '../../../../src/io/worktree/maintenance/command.js';
import { runWorktreeMaintenance } from '../../../../src/io/worktree/maintenance.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { fixtureMachineSettings } from '../../../../../../packages/gate/tests/fixtures/testkit.js';

/** A real repository on main, with seat worktrees and item folders beside it. */
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
  const board = { seats: [], items: [], takeoverMs: 30 * 60_000 };
  const recent = new Date(Date.now() - 40 * 60_000).toISOString();
  const seat = (name, agent) => {
    const path = join(box.dir, name);
    git(repo, 'worktree', 'add', '-q', '--detach', path, 'main');
    board.seats.push({ agent_id: agent, agent_path: path, presence: 'live', heartbeatAt: recent });
    return path;
  };
  /** An item folder on its own branch with one commit of work, as claim makes it. */
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
  return { box, config, ports, repo, git, board, seat, itemFolder, events, run: () => runWorktreeMaintenance(repo, config, ports, { now: Date.now() }) };
}

test('cli.io-worktree-maintenance-claim-ended.clean-removed: clause 1: one sweep removes the clean folder of a released claim and of a lapsed lease with rule claim-ended, and leaves a live claim\'s folder untouched [B5,C7,#12530]', async t => {
  const fx = fixture(t);
  const builder = fx.seat('c-live', 'core-1');
  const released = fx.itemFolder(`${builder}-item-31`, 31), lapsed = fx.itemFolder(`${builder}-item-32`, 32), held = fx.itemFolder(`${builder}-item-33`, 33);
  fx.board.items.push({ item_id: 31, item_status: 'open', item_owner: null, item_built_by: 'core-1' },
    { item_id: 32, item_status: 'open', item_owner: null, item_built_by: 'core-1', item_lease_until: new Date(Date.now() - 3_600_000).toISOString() },
    { item_id: 33, item_status: 'claimed', item_owner: 'core-1', item_lease_until: new Date(Date.now() + 3_600_000).toISOString() });
  const report = await fx.run();
  const row = path => report.entries.find(entry => entry.path === path);
  for (const folder of [released, lapsed]) {
    assert.equal(existsSync(folder.path), false, `the ended claim's clean folder is gone: ${row(folder.path)?.reason}`);
    assert.equal(row(folder.path).action, 'swept');
    assert.equal(fx.events.find(event => event.path === folder.path).rule, 'claim-ended');
    assert.equal(fx.git(fx.repo, 'rev-parse', `core/item-${fx.events.find(event => event.path === folder.path).item}`).trim(), folder.commit, 'the branch keeps its commits');
  }
  assert.equal(existsSync(held.path), true, 'a live claim keeps its folder');
  assert.equal(existsSync(builder), true, 'the seat folder stays');
});

test('cli.io-worktree-maintenance-claim-ended.dirty-kept-then-removed: clause 2: a dirty folder of a released claim has its diff, untracked files included, at refs/pullboard/keep/<id> named in a fact on the item, is then removed, and a new claim gets its own folder on the branch with its commits kept [B5,C7,#12530]', async t => {
  const fx = fixture(t);
  const io = { cwd: fx.repo, clock: { now: () => new Date() }, nativeBoard: apiBoardOpeners, err() {}, say() {} };
  const ctx = context(io);
  const board = openKitBoard(ctx.file, ctx.clock, { gitRoot: fx.repo });
  t.after(() => store.closeBoard(board));
  const path = join(fx.box.dir, 'c-dirty'), agent = await joinAgent(fx.box, path), other = join(fx.box.dir, 'c-next');
  const id = await addFixtureItem(fx.box, 'Dirty released claim');
  store.claim(board, id, { agentId: agent, lane: 'web', leaseMs: 2 * 3_600_000, itemFolder: true, perSeat: 3,
    freeze: item => ({ text: item.item_title, digest: `fixture:${item.item_title}` }) });
  const folder = fx.itemFolder(`${path}-item-${id}`, id);
  writeFileSync(join(folder.path, 'unfinished.txt'), 'untracked work\n');
  writeFileSync(join(folder.path, `item-${id}.txt`), 'edited\n');
  store.release(board, id, agent, 'handing the item back');
  const ports = { ...maintenanceCommandPorts(ctx, 'coordinator'), archiveVolume: fx.ports.archiveVolume, workingDirectories: () => [] };
  const report = await runWorktreeMaintenance(fx.repo, fx.config, ports, { now: Date.now() });
  const row = report.entries.find(entry => entry.path === folder.path);
  const ref = `refs/pullboard/keep/${id}`;
  assert.equal(existsSync(folder.path), false, `the dirty folder is removed after its diff is kept: ${row?.reason}`);
  assert.equal(row.keepRef, ref);
  assert.equal(fx.git(fx.repo, 'show', `${ref}:unfinished.txt`).trim(), 'untracked work', 'the untracked file is in the keep ref');
  assert.equal(fx.git(fx.repo, 'show', `${ref}:item-${id}.txt`).trim(), 'edited', 'the tracked edit is in the keep ref');
  const commit = fx.git(fx.repo, 'rev-parse', ref).trim();
  assert.match(JSON.stringify(store.itemThread(board, id)), new RegExp(commit, 'u'), 'a fact on the item names the kept commit');
  assert.equal(fx.git(fx.repo, 'rev-parse', `core/item-${id}`).trim(), folder.commit, 'the item branch keeps its commits');
  fx.git(fx.repo, 'worktree', 'add', '-q', other, `core/item-${id}`);
  assert.equal(fx.git(other, 'rev-parse', 'HEAD').trim(), folder.commit, 'the next claim gets its own folder on the branch');
  assert.equal(fx.git(fx.repo, 'rev-parse', ref).trim(), commit, 'the keep ref is never deleted');
});
