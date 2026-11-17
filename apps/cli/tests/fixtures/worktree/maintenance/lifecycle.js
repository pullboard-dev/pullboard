/** @pullboard-test-loads apps/cli/src/io/commands/withdraw.js apps/cli/src/io/commands/handoff.js apps/cli/src/io/worktree/maintenance/command.js packages/state/index.js */
/** Private CLI lifecycle cases for dirty withdrawal and completed seat takeover [B3,C7,N26]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import {
  closeBoard,
  openBoard,
} from '../../../../../lib/index.js';
import { workingDirectories } from '../../../../../../packages/landing/index.js';
import { agentHandoff } from '../../../../../../packages/state/index.js';
import { startFixtureChild } from '../../child.js';
import { createE2eHelpers } from '../../e2e.js';
import { fixtureAdd } from '../../testkit.js';
import { fixtureJoin } from '../../testkit.js';
import { fixtureSettledMachine } from '../../testkit.js';

/** Keep an exact native timer owner registered so lifecycle cases never launch a scheduler. */
export function retainFixtureTimer(box) {
  const common = box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const directory = join(common, 'pullboard', 'worktree-maintenance');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(directory, 'timer.guard.sqlite'), '', { mode: 0o600 });
  const started = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='],
    { encoding: 'utf8', env: { ...box.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } }).trim();
  fs.writeFileSync(join(directory, 'timer.json'), JSON.stringify({ version: 1, token: randomUUID(), pid: process.pid,
    started, dueAt: new Date(Date.now() + 3_600_000).toISOString(), root: box.repo, common }), { mode: 0o600 });
  return common;
}

/**
 * Commit opt-in only in this disposable project's main checkout.
 * Why in process: the commit runs its hooks in this process (test.inProcessHooks on) instead of two node children [C7,#10462].
 */
export async function enable(box) {
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: true } });
  const file = join(box.repo, 'pullboard.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.worktreeMaintenance = { enabled: true, every: '1h', grace: '1d', exclude: [] };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  const committed = await box.tryGit(box.repo, 'commit', '-qm', 'chore: enable private lifecycle maintenance fixture');
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
}

/** Add one ordinary native item for a private builder checkout. */
export async function addFixtureItem(box, title) {
  const added = await fixtureAdd(box.runIn, box.repo, 'web', title, '--specs', 'G1', '--route', 'mid',
    '--criterion', 'The private lifecycle fixture retains the builder source.', '--check', 'true',
    '--brief', 'Files: web/page.js\nChange: exercise private lifecycle cleanup\nTest: native cleanup archives source first', '--json');
  assert.equal(added.code, 0, added.err);
  return JSON.parse(added.out).item.item_id;
}

/** Find one actual recovery manifest for the specific private linked checkout. */
export function archiveFor(common, root) {
  const directory = join(common, 'pullboard', 'worktree-archives');
  if (!fs.existsSync(directory)) return null;
  for (const name of fs.readdirSync(directory)) {
    const archive = join(directory, name), manifest = JSON.parse(fs.readFileSync(join(archive, 'manifest.json'), 'utf8'));
    if (resolve(manifest.root) === resolve(root)) return { directory: archive, manifest };
  }
  return null;
}

/** Check the exact private archived bytes rather than relying on a cleanup log alone. */
export function assertArchivedBytes(archive, name, expected) {
  const file = archive.manifest.files.find(row => row.path === name);
  assert.ok(file, `${name} is present in the private recovery manifest`);
  assert.deepEqual(fs.readFileSync(join(archive.directory, 'blobs', file.sha256)), expected);
}

/** Join a temporary agent checkout and return its native seat identity. */
export async function joinAgent(box, path) {
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'main');
  const joined = await fixtureJoin(box.runIn, path, 'web', '--json');
  assert.equal(joined.code, 0, joined.err);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return store.listAgents(board).find(row => resolve(row.agent_path) === resolve(path)).agent_id; }
  finally { closeBoard(board); }
}

/** The time the native board recorded this seat's handoff as taken, read once through the one board opener of this fixture [C7,#10462]. */
export function handoffTakenAt(common, agentId) {
  const board = openBoard(join(common, 'pullboard', 'board.sqlite'));
  try { return agentHandoff(board, agentId)?.takenAt; }
  finally { closeBoard(board); }
}

/** Register actual CLI lifecycle checks; importing this fixture does not run them. */
export function registerMaintenanceCliLifecycleTests() {
  test('coordinator withdrawal archives the claimed builder checkout before cleaning it [B3,C7,N26]', async t => {
    const helpers = createE2eHelpers(); t.after(helpers.cleanup);
    const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }), { withWorktree: false });
    await enable(box);
    const common = retainFixtureTimer(box), owner = join(box.dir, 'withdraw-owner');
    const ownerId = await joinAgent(box, owner), item = await addFixtureItem(box, 'Private withdraw lifecycle archive');
    const claimed = await box.runIn(owner, 'claim', String(item), '--json');
    assert.equal(claimed.code, 0, claimed.err);
    const bytes = Buffer.from([0, 19, 20, 255]);
    fs.writeFileSync(join(owner, 'unfinished.bin'), bytes);

    const withdrawn = await box.runIn(box.repo, 'withdraw', String(item), 'private lifecycle fixture completed', '--json');
    assert.equal(withdrawn.code, 0, withdrawn.err);
    assert.equal(fs.existsSync(join(owner, 'unfinished.bin')), false, 'withdrawal cleans the original builder path');
    assert.equal(box.git(owner, 'status', '--porcelain').trim(), '');
    const archive = archiveFor(common, owner);
    assert.ok(archive, 'withdrawal retains a recovery archive for the original builder checkout');
    assertArchivedBytes(archive, 'unfinished.bin', bytes);
    const board = openBoard(join(common, 'pullboard', 'board.sqlite'));
    try { assert.equal(store.listAgents(board).find(row => row.agent_id === ownerId)?.agent_path, owner); }
    finally { closeBoard(board); }
    const log = await box.runIn(box.repo, 'log', String(item), '--json');
    assert.equal(log.code, 0, log.err);
    assert.match(log.out, /Worktree work archived before maintenance cleanup/u);
  });

  test('coordinator withdrawal defers dirty cleanup for a live cwd and health reports it [B3,C7,N26]', { timeout: 20_000 }, async t => {
    const helpers = createE2eHelpers(); t.after(helpers.cleanup);
    const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }), { withWorktree: false });
    await enable(box);
    const common = retainFixtureTimer(box), owner = join(box.dir, 'withdraw-busy-owner');
    await joinAgent(box, owner);
    const item = await addFixtureItem(box, 'Private deferred withdrawal cleanup');
    const claimed = await box.runIn(owner, 'claim', String(item), '--json');
    assert.equal(claimed.code, 0, claimed.err);
    const bytes = Buffer.from([0, 25, 26, 255]);
    const dirtyPath = join(owner, 'unfinished.bin');
    fs.writeFileSync(dirtyPath, bytes);

    const worker = startFixtureChild('/bin/sleep', ['60'], { cwd: owner, env: box.env, stdio: 'ignore' });
    t.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGTERM');
        await once(worker, 'close');
      }
    });
    const deadline = Date.now() + 5_000;
    let census;
    while (Date.now() < deadline) {
      census = workingDirectories();
      if (census?.some(row => row.pid === worker.pid && resolve(row.path) === resolve(owner))) break;
      await pause(25);
    }
    assert.ok(census?.some(row => row.pid === worker.pid && resolve(row.path) === resolve(owner)),
      'the real process census observes another process in the builder checkout');

    const withdrawn = await box.runIn(box.repo, 'withdraw', String(item), 'retain while the private worker is active', '--json');
    assert.equal(withdrawn.code, 0, withdrawn.err);
    assert.deepEqual(fs.readFileSync(dirtyPath), bytes);
    assert.notEqual(box.git(owner, 'status', '--porcelain').trim(), '', 'withdrawal leaves dirty source untouched');
    assert.equal(archiveFor(common, owner), null, 'deferred cleanup does not create a misleading recovery archive');

    const health = await box.runIn(box.repo, 'health', '--json');
    assert.equal(health.code, 1, health.err);
    const deferred = JSON.parse(health.out).dirtyWorktrees.find(row => row.kind === 'withdrawal-retained'
      && row.item === item && resolve(row.path) === resolve(owner));
    assert.ok(deferred, 'health exposes the deferred coordinator withdrawal by item and path');
    assert.ok(Number.isFinite(Date.parse(deferred.since)), 'health reports when deferred retention began');
    assert.equal(typeof deferred.reason, 'string');
    assert.ok(deferred.reason.length > 0);
  });
}
