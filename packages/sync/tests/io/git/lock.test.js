/** Private coordination databases exercise real Git lease fencing, never a board database [H11,C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { inspectGitSyncLock } from '../../../index.js';
import { withGitSyncLock } from '../../../index.js';

/** Own only disposable marker/lock paths below this test's fresh temporary directory. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-git-sync-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, 'git-sync.json');
  return { root, marker, lock: marker + '.lock', lease: marker + '.lease.sqlite' };
}

/** Verify an out-of-range process is actually absent rather than assuming a recently exited PID stays free. */
function deadPid() {
  const pid = 2_147_483_000;
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return pid; throw error; }
  throw new Error('the private dead-owner fixture PID is in use');
}

/** Seed the exact legacy coordination schema, not any saved board identity or native grant. */
function legacyLease(box, pid) {
  const token = randomUUID();
  const db = new DatabaseSync(box.lease);
  try {
    db.exec('CREATE TABLE relay_lease(name TEXT PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL)');
    db.prepare("INSERT INTO relay_lease(name,pid,token) VALUES ('relay',?,?)").run(pid, token);
  } finally { db.close(); }
  mkdirSync(box.lock);
  writeFileSync(join(box.lock, 'pid'), String(pid) + '\n');
  return token;
}

/** Synchronize actual lock callbacks without sleeps, timing margins or fabricated capabilities. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('sync.git-lock.dead-lock-quarantined: a dead legacy Git lock is quarantined intact with recovery metadata outside it [H11,C7]', async t => {
  const box = fixture(t);
  const pid = deadPid();
  legacyLease(box, pid);
  const original = readFileSync(join(box.lock, 'pid'));
  const summaries = [];
  assert.equal(inspectGitSyncLock(box.marker).state, 'dead');
  const result = await withGitSyncLock(box.marker, ({ assertHeld, owner }) => {
    assertHeld();
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.command, 'sync');
    assert.equal(summaries.length, 1, 'quarantine publication precedes the real callback');
    return 'held';
  }, { relayCommand: { cliOperation: 'sync' }, onQuarantine: value => summaries.push(value) });
  assert.equal(result, 'held');
  const summary = summaries[0];
  assert.equal(summary.version, 1);
  assert.equal(summary.reason, 'dead-owner');
  assert.equal(new Date(summary.at).toISOString(), summary.at);
  assert.equal(summary.artifacts.length, 1);
  const artifact = summary.artifacts[0];
  assert.equal(artifact.name, basename(box.marker) + '.lock');
  assert.equal(artifact.pid, pid);
  assert.equal(artifact.command, 'unknown', 'a legacy pid does not reveal a command');
  assert.equal(new Date(artifact.at).toISOString(), artifact.at);
  assert.equal(dirname(dirname(artifact.path)), join(box.root, 'quarantine'));
  assert.match(basename(dirname(artifact.path)), /^git-sync-\d+-[a-f0-9-]+$/u);
  assert.deepEqual(readFileSync(join(artifact.path, 'pid')), original);
  assert.deepEqual(readdirSync(artifact.path), ['pid'], 'the archived directory gains no metadata files');
  const recovery = join(dirname(artifact.path), 'recovery.json');
  assert.deepEqual(JSON.parse(readFileSync(recovery, 'utf8')), summary);
  assert.equal(existsSync(box.lock), false, 'normal release removes only the new owner directory');
  assert.equal(inspectGitSyncLock(box.marker).state, 'absent');
});

test('sync.git-lock.live-lease-untouched: a live legacy Git lease has unknown expiry and an aborted waiter leaves it untouched [H11,C7]', async t => {
  const box = fixture(t);
  const originalToken = legacyLease(box, process.pid);
  const original = readFileSync(join(box.lock, 'pid'));
  const observed = inspectGitSyncLock(box.marker);
  assert.deepEqual(observed, { pid: process.pid, command: null, startedAt: null, expiresAt: null, state: 'unknown' });
  const abort = new AbortController();
  abort.abort();
  let entered = false;
  let quarantined = false;
  await assert.rejects(withGitSyncLock(box.marker, () => { entered = true; }, {
    relaySignal: abort.signal, onQuarantine: () => { quarantined = true; },
  }), { code: 'RELAY_TIMEOUT' });
  assert.equal(entered, false);
  assert.equal(quarantined, false);
  assert.deepEqual(readFileSync(join(box.lock, 'pid')), original);
  assert.deepEqual(inspectGitSyncLock(box.marker), observed);
  const db = new DatabaseSync(box.lease, { readOnly: true });
  try {
    assert.deepEqual({ ...db.prepare("SELECT pid,token FROM relay_lease WHERE name='relay'").get() },
      { pid: process.pid, token: originalToken });
  } finally { db.close(); }
});

test('sync.git-lock.expired-owner-fenced: an actual expired Git owner is fenced and its finally cannot release the successor [H11,C7]', async t => {
  const box = fixture(t);
  const firstEntered = deferred();
  const finishFirst = deferred();
  const secondEntered = deferred();
  const finishSecond = deferred();
  const quarantines = [];
  let oldCapability;
  let nextCapability;
  let second;
  const first = withGitSyncLock(box.marker, async capability => {
    oldCapability = capability;
    firstEntered.resolve();
    await finishFirst.promise;
    return 'old';
  }, { relayCommand: { cliOperation: 'submit' } });
  first.catch(firstEntered.reject);
  try {
    await firstEntered.promise;
    // This is this fixture's private coordination lease, not board.sqlite or a simulated capability.
    const db = new DatabaseSync(box.lease);
    let oldToken;
    try {
      oldToken = db.prepare("SELECT token FROM relay_lease WHERE name='relay'").get().token;
      assert.equal(db.prepare("UPDATE relay_lease SET git_started_at=0,git_expires_at=1 WHERE name='relay' AND token=?")
        .run(oldToken).changes, 1);
    } finally { db.close(); }
    assert.equal(inspectGitSyncLock(box.marker).state, 'expired');
    second = withGitSyncLock(box.marker, async capability => {
      nextCapability = capability;
      secondEntered.resolve();
      await finishSecond.promise;
      return 'new';
    }, { relayCommand: { cliOperation: 'sync' }, onQuarantine: value => quarantines.push(value) });
    second.catch(secondEntered.reject);
    await secondEntered.promise;
    assert.equal(quarantines.length, 1);
    assert.equal(quarantines[0].reason, 'expired-lease');
    assert.equal(quarantines[0].artifacts[0].command, 'submit');
    assert.equal(readFileSync(join(quarantines[0].artifacts[0].path, 'git-token'), 'utf8'), oldToken);
    assert.throws(() => oldCapability.assertHeld(), { code: 'GIT_SYNC_LOCK_LOST' });
    const oldRejected = assert.rejects(first, { code: 'GIT_SYNC_LOCK_LOST' });
    finishFirst.resolve();
    await oldRejected;
    nextCapability.assertHeld();
    const live = inspectGitSyncLock(box.marker);
    assert.equal(live.state, 'live');
    assert.equal(live.command, 'sync');
    finishSecond.resolve();
    assert.equal(await second, 'new');
    assert.equal(inspectGitSyncLock(box.marker).state, 'absent');
  } finally {
    finishFirst.resolve();
    finishSecond.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});

test('sync.git-lock.callback-error-survives-cleanup-failure: a callback error survives a real private SQLite cleanup failure [H11,C7]', async t => {
  const box = fixture(t);
  const original = new Error('private fixture callback failed');
  const diagnostics = [];
  await assert.rejects(withGitSyncLock(box.marker, ({ assertHeld }) => {
    assertHeld();
    // Remove only the disposable coordination table to produce an actual SQLite cleanup failure.
    const db = new DatabaseSync(box.lease);
    try { db.exec('DROP TABLE relay_lease'); } finally { db.close(); }
    throw original;
  }, { err: value => diagnostics.push(value) }), error => error === original);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /lease cleanup failed after an earlier error/u);
  assert.ok(existsSync(box.lock), 'failed cleanup retains the owner evidence for recovery');
});

test('sync.git-lock.symlink-owner-no-takeover: a symlink owner file remains unknown and never supplies takeover authority [H11,C7]', async t => {
  const box = fixture(t);
  mkdirSync(box.lock);
  const target = join(box.root, 'unrelated-private-input');
  const bytes = String(deadPid()) + '\n';
  writeFileSync(target, bytes);
  symlinkSync(target, join(box.lock, 'pid'));
  assert.equal(inspectGitSyncLock(box.marker).state, 'unknown');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(withGitSyncLock(box.marker, () => assert.fail('unsafe owner entered'),
    { relaySignal: abort.signal }), { code: 'RELAY_TIMEOUT' });
  assert.equal(readFileSync(target, 'utf8'), bytes);
  assert.equal(inspectGitSyncLock(box.marker).state, 'unknown');
});
