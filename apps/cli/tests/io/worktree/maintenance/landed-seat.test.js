/** @pullboard-test-loads apps/cli/src/io/worktree/maintenance.js apps/cli/src/io/worktree/maintenance/landed-seat.js */
/** A seat whose item lands or is withdrawn is removed by worktree maintenance when it is clean and idle; dirty, claimed and spare seats stay [C7,#10783]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { maintenanceCommitsSafe } from '../../../../src/io/worktree/maintenance.js';
import { maintenanceDirtyPaths } from '../../../../src/io/worktree/maintenance.js';
import { runWorktreeMaintenance } from '../../../../src/io/worktree/maintenance.js';
import { retireLandedSeats } from '../../../../src/io/worktree/maintenance/landed-seat.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { fixtureMachineSettings } from '../../../../../../packages/gate/tests/fixtures/testkit.js';

/** A real repository on main, detached seat worktrees and branch item folders outside it, and a board snapshot the test edits. */
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
  const git = (cwd, ...args) => box.git(cwd, ...args);
  const board = { seats: [], items: [] };
  /** Join a seat: a detached worktree at main with an idle seat row. */
  const seat = (name, agent) => {
    const path = join(box.dir, name);
    git(repo, 'worktree', 'add', '-q', '--detach', path, 'main');
    board.seats.push({ agent_id: agent, agent_path: path, presence: 'idle' });
    return path;
  };
  /** Open the seat's item folder on its own branch with one commit of work, as claim does; returns the commit. */
  const itemFolder = (seatPath, id) => {
    const path = `${seatPath}-item-${id}`;
    git(repo, 'worktree', 'add', '-q', '-b', `core/item-${id}`, path, 'main');
    writeFileSync(join(path, `item-${id}.txt`), 'work\n');
    git(path, 'add', '.');
    // Plumbing, not `git commit`: the fixture repository's pre-commit hook refuses commits from a seat folder.
    const tree = String(git(path, 'write-tree')).trim();
    const commit = String(git(path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit-tree', tree, '-p', 'HEAD', '-m', `item ${id}`)).trim();
    git(path, 'update-ref', 'HEAD', commit);
    return { path, commit };
  };
  const recorded = [];
  const ports = { agentId: 'coordinator', readSnapshot: async () => structuredClone(board), workingDirectories: () => [],
    recordDirty: async record => { recorded.push(record); },
    archiveVolume: () => ({ freeBytes: 900 * 2 ** 30, totalBytes: 1000 * 2 ** 30 }) };
  const config = { worktrees: 'beside', worktreeMaintenance: { enabled: true, every: '1h', grace: '1d', exclude: [] } };
  const listed = () => String(git(repo, 'worktree', 'list'));
  return { repo, git, board, seat, itemFolder, ports, recorded, listed, run: (now = Date.now()) => runWorktreeMaintenance(repo, config, ports, { now }) };
}

test('cli.io-worktree-maintenance-landed-seat.landed-seat-and-folder-removed: clause 1: after an item lands, its clean builder seat and item folder with no live claim are removed within one maintenance cycle, and a pool spare stays [C7,#10783]', async t => {
  const fx = fixture(t);
  const seat = fx.seat('b-landed', 'core-1'), spare = fx.seat('b-landed-spare', 'core-2');
  const folder = fx.itemFolder(seat, 7);
  fx.board.items.push({ item_id: 7, item_status: 'done', item_owner: null, item_built_by: 'core-1', item_commit: folder.commit, item_merged_commit: 'f'.repeat(40) });
  const report = await fx.run();
  const row = path => report.entries.find(entry => entry.path === path);
  assert.equal(existsSync(seat), false, `the landed item's seat is gone: ${row(seat)?.reason}`);
  assert.equal(existsSync(folder.path), false, `its item folder is gone: ${row(folder.path)?.reason}`);
  assert.equal(row(seat).action, 'retired-landed');
  assert.equal(row(folder.path).action, 'retired-landed');
  assert.match(row(seat).reason, /item #7 landed/u);
  assert.equal(report.pruned, 2);
  assert.doesNotMatch(fx.listed(), /b-landed /u, 'Git no longer lists the seat');
  assert.doesNotMatch(fx.listed(), /b-landed-item-7/u, 'Git no longer lists the item folder');
  assert.match(String(fx.git(fx.repo, 'branch', '--list', 'core/item-7')), /core\/item-7/u, 'the item branch, and its commits, stay');
  assert.equal(existsSync(spare), true, 'a pool spare seat is never removed');
  assert.equal(existsSync(fx.repo), true, 'the main checkout stays');
});

test('cli.io-worktree-maintenance-landed-seat.dirty-seat-kept-and-named: clause 2: a seat with uncommitted changes is kept and named in the maintenance log, once per set of dirty paths [C7,#10783]', async t => {
  const fx = fixture(t);
  const seat = fx.seat('b-dirty', 'core-3');
  fx.board.items.push({ item_id: 8, item_status: 'withdrawn', item_owner: null, item_built_by: 'core-3', item_withdrawn_reason: 'not needed' });
  writeFileSync(join(seat, 'unsaved.txt'), 'unfinished\n');
  const report = await fx.run();
  const entry = report.entries.find(row => row.path === seat);
  assert.equal(existsSync(seat), true, 'the dirty seat stays');
  assert.equal(existsSync(join(seat, 'unsaved.txt')), true, 'its uncommitted work is untouched');
  assert.equal(entry.action, 'kept');
  assert.equal(entry.reason, `uncommitted changes in ${seat}; worktree kept`, 'the maintenance log names the seat');
  assert.deepEqual(entry.dirtyPaths, ['unsaved.txt']);
  assert.equal(report.pruned, 0);
  assert.equal(fx.recorded.length, 1, 'the kept seat is recorded on its item');
  assert.equal(fx.recorded[0].path, seat);
  assert.deepEqual(fx.recorded[0].items, [8]);
  await fx.run();
  assert.equal(fx.recorded.length, 1, 'the same dirty paths are not recorded again on the next cycle');
  assert.equal(existsSync(seat), true);
});

test('cli.io-worktree-maintenance-landed-seat.live-claim-seat-kept: clause 3: a seat holding a live claim on another item is never removed, through the maintenance cycle that calls landed-seat.js [C7,#10783]', async t => {
  const fx = fixture(t);
  const seat = fx.seat('b-busy', 'core-4');
  const folder = fx.itemFolder(seat, 9);
  fx.board.items.push({ item_id: 9, item_status: 'done', item_owner: null, item_built_by: 'core-4', item_commit: folder.commit, item_merged_commit: 'e'.repeat(40) },
    { item_id: 10, item_status: 'claimed', item_owner: 'core-4', item_lease_until: new Date(Date.now() + 3_600_000).toISOString() });
  const report = await fx.run();
  for (const path of [seat, folder.path]) {
    assert.equal(existsSync(path), true, `${path} is kept while its seat holds a claim`);
    assert.equal(report.entries.find(row => row.path === path).action, 'kept');
  }
  assert.equal(report.pruned, 0);
  // landed-seat.js refuses on its own, even for an entry the classifier left as an idle candidate.
  const entries = [seat, folder.path].map(path => ({ path, action: 'kept', reason: 'seat-idle', agents: ['core-4'] }));
  const direct = { pruned: 0, freedBytes: 0 };
  await retireLandedSeats(fx.repo, entries, { mainRoot: fx.repo, now: Date.now(), observed: await fx.ports.readSnapshot(), ports: fx.ports,
    report: direct, state: { trees: {} }, dirtyPaths: maintenanceDirtyPaths, commitsSafe: maintenanceCommitsSafe });
  assert.deepEqual(entries.map(entry => entry.action), ['kept', 'kept']);
  assert.equal(direct.pruned, 0);
  for (const path of [seat, folder.path]) assert.equal(existsSync(path), true);
  assert.match(fx.listed(), /b-busy-item-9/u);
});
