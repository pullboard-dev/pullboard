/** snapshotWip keeps an item folder's work on a board ref without touching the builder's index [C7,#12568]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { watch } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { snapshotOnBoardCall } from '../../../src/io/beater.js';
import { snapshotWip } from '../../../src/io/item/wip.js';
import { wipRef } from '../../../src/io/item/wip.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { policyRepository } from '../../../../../packages/store/tests/fixtures/submit.js';

/** A folder with one tracked file at HEAD, plus staged, unstaged and untracked changes. */
function dirtyFolder(t) {
  const root = privateFixtureFiles('pullboard-item-wip-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'folder');
  mkdirSync(folder);
  policyRepository(folder);
  const git = (...args) => runFixtureGit(args, { cwd: folder });
  writeFileSync(join(folder, 'tracked.txt'), 'one\n');
  git('add', 'tracked.txt');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=F', '-c', 'user.email=f@example.test', 'commit', '-q', '-m', 'tracked');
  writeFileSync(join(folder, 'staged.txt'), 'staged\n');
  git('add', 'staged.txt');
  writeFileSync(join(folder, 'tracked.txt'), 'one\nunstaged\n');
  writeFileSync(join(folder, 'untracked.txt'), 'untracked\n');
  return { folder, git };
}

/** What the builder sees of the folder: index bytes and mtime, HEAD and status. */
function builderState(folder, git) {
  // A plain status can rewrite the index's stat cache; --no-optional-locks never writes it, so the index bytes and mtime are the builder's own.
  const status = git('--no-optional-locks', 'status', '--porcelain=v1');
  const head = git('rev-parse', 'HEAD');
  const index = join(folder, '.git', 'index');
  return { bytes: readFileSync(index).toString('hex'), mtime: statSync(index).mtimeMs, head, status };
}

test('cli.io-item-wip.snapshot-keeps-builder-state: clause 1: snapshotWip saves staged, unstaged and untracked work to refs/pullboard/wip/<item> and leaves index, HEAD and status unchanged [C7,#12568]', t => {
  const { folder, git } = dirtyFolder(t);
  const before = builderState(folder, git);
  const first = snapshotWip(folder, 12596);
  assert.equal(first.written, true);
  assert.deepEqual(builderState(folder, git), before);
  assert.equal(git('rev-parse', wipRef(12596)), first.commit);
  assert.equal(git('show', `${first.commit}:staged.txt`), 'staged');
  assert.equal(git('show', `${first.commit}:tracked.txt`), 'one\nunstaged');
  assert.equal(git('show', `${first.commit}:untracked.txt`), 'untracked');
  writeFileSync(join(folder, 'untracked.txt'), 'changed\n');
  const second = snapshotWip(folder, 12596);
  assert.equal(second.written, true);
  assert.equal(git('rev-parse', `${second.commit}^`), first.commit);
  assert.equal(builderState(folder, git).bytes, before.bytes);
});

test('cli.io-item-wip.snapshot-skips: clause 2: an unchanged folder writes no new snapshot and none runs while index.lock exists [C7,#12568]', t => {
  const { folder, git } = dirtyFolder(t);
  const first = snapshotWip(folder, 7);
  const again = snapshotWip(folder, 7);
  assert.deepEqual([again.written, again.reason, again.commit], [false, 'unchanged', first.commit]);
  writeFileSync(join(folder, 'untracked.txt'), 'changed\n');
  const lock = join(folder, '.git', 'index.lock');
  writeFileSync(lock, '');
  const locked = snapshotWip(folder, 7);
  assert.deepEqual([locked.written, locked.reason], [false, 'locked']);
  assert.equal(git('rev-parse', wipRef(7)), first.commit);
  rmSync(lock);
  assert.equal(snapshotWip(folder, 7).written, true);
});

/** The options that make a board call by seat core-1 see one claimed folder, with a clock the test owns. */
function claimedCall(folder, now) {
  return { seatOf: () => ({ seat: 'core-1', board: '/nowhere/board.sqlite' }), now: () => now, claimed: async () => [{ item: 12746, folder }] };
}

/** Watch the folder's refs, so the test learns of the background worker's snapshot from the ref change itself, not from a timer. */
function watchRef(folder, git, item) {
  const stop = new AbortController();
  const seen = async () => {
    const found = () => { try { return git('rev-parse', '--verify', '-q', wipRef(item)); } catch { return null; } };
    try {
      for await (const change of watch(join(folder, '.git', 'refs'), { recursive: true, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(20_000)]) })) {
        const commit = change && found();
        if (commit) return commit;
      }
    } catch { /* stopped by the test, or the watch timed out: the caller reads the ref once more */ }
    return found();
  };
  return { seen: seen(), found: () => { try { return git('rev-parse', '--verify', '-q', wipRef(item)); } catch { return null; } }, stop: () => stop.abort() };
}

test('cli.io-item-wip.snapshot-does-not-block-the-command: clause 1: a board call with a snapshot due returns within 20 ms of the same call with none due, on a dirty item folder [C7,#12746]', async t => {
  const { folder, git } = dirtyFolder(t);
  const options = claimedCall(folder, 9_000_000);
  const ref = watchRef(folder, git, 12746);
  const due = process.hrtime.bigint();
  await snapshotOnBoardCall(folder, options);
  const dueMs = Number(process.hrtime.bigint() - due) / 1e6;
  const none = process.hrtime.bigint();
  await snapshotOnBoardCall(folder, options);
  const noneMs = Number(process.hrtime.bigint() - none) / 1e6;
  console.log(`BOARD-CALL-WAIT snapshot-due ${dueMs.toFixed(1)} ms; none-due ${noneMs.toFixed(1)} ms; difference ${(dueMs - noneMs).toFixed(1)} ms`);
  assert.ok(dueMs - noneMs < 20, `a due snapshot made the call wait ${(dueMs - noneMs).toFixed(1)} ms longer`);
  assert.ok(ref.found() ?? await ref.seen, 'the background worker still wrote the snapshot');
  ref.stop();
});

test('cli.io-item-wip.snapshot-survives-command-exit: clause 2: after the command returns, its own process holds no snapshot work and refs/pullboard/wip/<item> still comes to hold the uncommitted change [C7,#12746]', async t => {
  const { folder, git } = dirtyFolder(t);
  const ref = watchRef(folder, git, 12746);
  // The call hands the snapshot to a detached worker process and returns; the CLI's process.exit after main cannot reach that worker.
  await snapshotOnBoardCall(folder, claimedCall(folder, 9_000_000));
  const commit = ref.found() ?? await ref.seen;
  ref.stop();
  assert.ok(commit, 'the worker wrote refs/pullboard/wip/<item>');
  assert.equal(git('show', `${commit}:untracked.txt`), 'untracked');
  assert.equal(git('show', `${commit}:tracked.txt`), 'one\nunstaged');
  assert.equal(git('show', `${commit}:staged.txt`), 'staged');
});
