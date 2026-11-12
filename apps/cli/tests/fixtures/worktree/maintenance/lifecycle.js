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

/** Keep an exact native timer owner registered so lifecycle cases never launch a scheduler. */
function retainFixtureTimer(box) {
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

/** Commit opt-in only in this disposable project's main checkout. */
function enable(box) {
  const file = join(box.repo, 'pullboard.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.worktreeMaintenance = { enabled: true, every: '1h', grace: '1d', exclude: [] };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-qm', 'chore: enable private lifecycle maintenance fixture');
}

/** Add one ordinary native item for a private builder checkout. */
function addFixtureItem(box, title) {
  const added = fixtureAdd(box.run, box.repo, 'web', title, '--specs', 'G1', '--route', 'mid',
    '--criterion', 'The private lifecycle fixture retains the builder source.', '--check', 'true',
    '--brief', 'Files: web/page.js\nChange: exercise private lifecycle cleanup\nTest: native cleanup archives source first', '--json');
  assert.equal(added.code, 0, added.err);
  return JSON.parse(added.out).item.item_id;
}

/** Find one actual recovery manifest for the specific private linked checkout. */
function archiveFor(common, root) {
  const directory = join(common, 'pullboard', 'worktree-archives');
  if (!fs.existsSync(directory)) return null;
  for (const name of fs.readdirSync(directory)) {
    const archive = join(directory, name), manifest = JSON.parse(fs.readFileSync(join(archive, 'manifest.json'), 'utf8'));
    if (resolve(manifest.root) === resolve(root)) return { directory: archive, manifest };
  }
  return null;
}

/** Check the exact private archived bytes rather than relying on a cleanup log alone. */
function assertArchivedBytes(archive, name, expected) {
  const file = archive.manifest.files.find(row => row.path === name);
  assert.ok(file, `${name} is present in the private recovery manifest`);
  assert.deepEqual(fs.readFileSync(join(archive.directory, 'blobs', file.sha256)), expected);
}

/** Join a temporary agent checkout and return its native seat identity. */
function joinAgent(box, path) {
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'main');
  const joined = fixtureJoin(box.run, path, 'web', '--json');
  assert.equal(joined.code, 0, joined.err);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return store.listAgents(board).find(row => resolve(row.agent_path) === resolve(path)).agent_id; }
  finally { closeBoard(board); }
}

/** Register actual CLI lifecycle checks; importing this fixture does not run them. */
export function registerMaintenanceCliLifecycleTests() {
  test('coordinator withdrawal archives the claimed builder checkout before cleaning it [B3,C7,N26]', t => {
    const helpers = createE2eHelpers(); t.after(helpers.cleanup);
    const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }), { withWorktree: false });
    enable(box);
    const common = retainFixtureTimer(box), owner = join(box.dir, 'withdraw-owner');
    const ownerId = joinAgent(box, owner), item = addFixtureItem(box, 'Private withdraw lifecycle archive');
    const claimed = box.run(owner, 'claim', String(item), '--json');
    assert.equal(claimed.code, 0, claimed.err);
    const bytes = Buffer.from([0, 19, 20, 255]);
    fs.writeFileSync(join(owner, 'unfinished.bin'), bytes);

    const withdrawn = box.run(box.repo, 'withdraw', String(item), 'private lifecycle fixture completed', '--json');
    assert.equal(withdrawn.code, 0, withdrawn.err);
    assert.equal(fs.existsSync(join(owner, 'unfinished.bin')), false, 'withdrawal cleans the original builder path');
    assert.equal(box.git(owner, 'status', '--porcelain').trim(), '');
    const archive = archiveFor(common, owner);
    assert.ok(archive, 'withdrawal retains a recovery archive for the original builder checkout');
    assertArchivedBytes(archive, 'unfinished.bin', bytes);
    const board = openBoard(join(common, 'pullboard', 'board.sqlite'));
    try { assert.equal(store.listAgents(board).find(row => row.agent_id === ownerId)?.agent_path, owner); }
    finally { closeBoard(board); }
    const log = box.run(box.repo, 'log', String(item), '--json');
    assert.equal(log.code, 0, log.err);
    assert.match(log.out, /Worktree work archived before maintenance cleanup/u);
  });

  test('coordinator withdrawal defers dirty cleanup for a live cwd and health reports it [B3,C7,N26]', { timeout: 20_000 }, async t => {
    const helpers = createE2eHelpers(); t.after(helpers.cleanup);
    const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }), { withWorktree: false });
    enable(box);
    const common = retainFixtureTimer(box), owner = join(box.dir, 'withdraw-busy-owner');
    joinAgent(box, owner);
    const item = addFixtureItem(box, 'Private deferred withdrawal cleanup');
    const claimed = box.run(owner, 'claim', String(item), '--json');
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

    const withdrawn = box.run(box.repo, 'withdraw', String(item), 'retain while the private worker is active', '--json');
    assert.equal(withdrawn.code, 0, withdrawn.err);
    assert.deepEqual(fs.readFileSync(dirtyPath), bytes);
    assert.notEqual(box.git(owner, 'status', '--porcelain').trim(), '', 'withdrawal leaves dirty source untouched');
    assert.equal(archiveFor(common, owner), null, 'deferred cleanup does not create a misleading recovery archive');

    const health = box.run(box.repo, 'health', '--json');
    assert.equal(health.code, 1, health.err);
    const deferred = JSON.parse(health.out).dirtyWorktrees.find(row => row.kind === 'withdrawal-retained'
      && row.item === item && resolve(row.path) === resolve(owner));
    assert.ok(deferred, 'health exposes the deferred coordinator withdrawal by item and path');
    assert.ok(Number.isFinite(Date.parse(deferred.since)), 'health reports when deferred retention began');
    assert.equal(typeof deferred.reason, 'string');
    assert.ok(deferred.reason.length > 0);
  });

  test('completed handoff cleans the outgoing checkout only after a clear native cwd census [B3,C7,N26]', t => {
    const helpers = createE2eHelpers(); t.after(helpers.cleanup);
    const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }), { withWorktree: false });
    enable(box);
    const common = retainFixtureTimer(box), outgoing = join(box.dir, 'handoff-outgoing'), incoming = join(box.dir, 'handoff-incoming');
    const outgoingId = joinAgent(box, outgoing), incomingId = joinAgent(box, incoming);
    const bytes = Buffer.from([0, 21, 22, 255]);
    fs.writeFileSync(join(outgoing, 'unfinished.bin'), bytes);
    const opened = box.run(outgoing, 'handoff', '--json');
    assert.equal(opened.code, 0, opened.err);
    const handoffItem = JSON.parse(opened.out).handoff.item;
    const taken = box.run(incoming, 'handoff', '--take', String(handoffItem), '--json');
    assert.equal(taken.code, 0, taken.err);
    const receipt = JSON.parse(taken.out).handoff;
    const board = openBoard(join(common, 'pullboard', 'board.sqlite'));
    try { assert.equal(agentHandoff(board, outgoingId)?.takenAt, receipt.takenAt); }
    finally { closeBoard(board); }

    assert.equal(fs.existsSync(join(outgoing, 'unfinished.bin')), false, 'the completed native takeover cleans the outgoing checkout');
    assert.equal(box.git(outgoing, 'status', '--porcelain').trim(), '');
    const archive = archiveFor(common, outgoing);
    assert.ok(archive, 'handoff cleanup keeps a private recovery archive');
    assertArchivedBytes(archive, 'unfinished.bin', bytes);
    const log = box.run(box.repo, 'log', String(handoffItem), '--json');
    assert.equal(log.code, 0, log.err);
    assert.match(log.out, /Worktree work archived before maintenance cleanup/u);
  });

  test('completed handoff retains dirty source when another native process still works there [B3,C7,N26]', { timeout: 20_000 }, async t => {
    const helpers = createE2eHelpers(); t.after(helpers.cleanup);
    const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }), { withWorktree: false });
    enable(box);
    const common = retainFixtureTimer(box), outgoing = join(box.dir, 'busy-outgoing'), incoming = join(box.dir, 'busy-incoming');
    const outgoingId = joinAgent(box, outgoing);
    joinAgent(box, incoming);
    const bytes = Buffer.from([0, 23, 24, 255]);
    fs.writeFileSync(join(outgoing, 'unfinished.bin'), bytes);
    const opened = box.run(outgoing, 'handoff', '--json');
    assert.equal(opened.code, 0, opened.err);
    const handoffItem = JSON.parse(opened.out).handoff.item;

    const worker = startFixtureChild('/bin/sleep', ['60'], { cwd: outgoing, env: box.env, stdio: 'ignore' });
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
      if (census?.some(row => row.pid === worker.pid && resolve(row.path) === resolve(outgoing))) break;
      await pause(25);
    }
    assert.ok(census?.some(row => row.pid === worker.pid && resolve(row.path) === resolve(outgoing)),
      'the real process census observes the other process in the outgoing checkout');

    const taken = box.run(incoming, 'handoff', '--take', String(handoffItem), '--json');
    assert.equal(taken.code, 0, taken.err);
    const receipt = JSON.parse(taken.out).handoff;
    const board = openBoard(join(common, 'pullboard', 'board.sqlite'));
    try { assert.equal(agentHandoff(board, outgoingId)?.takenAt, receipt.takenAt); }
    finally { closeBoard(board); }
    assert.deepEqual(fs.readFileSync(join(outgoing, 'unfinished.bin')), bytes);
    assert.notEqual(box.git(outgoing, 'status', '--porcelain').trim(), '');
    assert.equal(archiveFor(common, outgoing), null, 'an occupied checkout is retained without an archive/reset');
    const log = box.run(box.repo, 'log', String(handoffItem), '--json');
    assert.equal(log.code, 0, log.err);
    assert.doesNotMatch(log.out, /Worktree work archived before maintenance cleanup/u);
  });
}
