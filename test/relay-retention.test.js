/** Real private relay lifecycle storage, controlled clocks and HTTP authorization [H18]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRelayAuth } from '../relay/auth.js';
import { createGitHubClient } from '../relay/github.js';
import { createRelayJournal } from '../relay/journal.js';
import { createRelayRetention } from '../relay/retention.js';
import { serveRelay } from '../relay/service.js';
import { githubFixture } from './relay-fixture.js';

const DAY = 86_400_000;
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const PERSON = { kind: 'person', userId: '7' };

/** Use actual sign-in with an independent lifecycle clock, so long inactivity does not fake token validity. */
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-retention-'));
  const data = join(root, 'data');
  const backups = join(root, 'backups');
  let clock = Date.UTC(2026, 0, 1);
  const provider = await githubFixture(t);
  const auth = createRelayAuth({ database: join(root, 'auth.sqlite'), github: createGitHubClient(provider.config), now: () => Date.now() });
  const flow = auth.beginWeb();
  const redirect = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const url = new URL(redirect.headers.get('location'));
  const signed = await auth.finishWeb(url.searchParams.get('state'), url.searchParams.get('code'), flow.binding);
  // Real auth link time uses its own wall clock; journal activity below is the controlled inactivity origin.
  await auth.linkBoard(signed.token, A, 'fixture/repository');
  await auth.linkBoard(signed.token, B, 'fixture/repository');
  const agent = await auth.issueToken(signed.token, { board: A, agent: 'worker' });
  const other = await auth.issueToken(signed.token, { board: B, agent: 'other' });
  const config = { directory: data, backupsDirectory: backups, auth, now: () => clock };
  const retention = createRelayRetention(config);
  const relay = await serveRelay({ ...config, maintenanceMs: 0, pollMs: 10 });
  t.after(async () => { await relay.close(); auth.close(); rmSync(root, { recursive: true, force: true }); });
  const key = randomBytes(32);
  const marker = 'PRIVATE_RETENTION_PAYLOAD';
  /** Seal only on the client; neither plaintext nor key is ever handed to the retention component. */
  function encrypted() {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.update(marker), cipher.final(), cipher.getAuthTag()]);
  }
  /** Close each journal after one trusted fixture operation. */
  function journal(id, work) {
    return auth.withBoard(id, () => {
      const db = createRelayJournal({ directory: data, boardId: id, now: () => new Date(clock) });
      try { return work(db); } finally { db.close(); }
    });
  }
  const payload = encrypted();
  for (const id of [A, B]) journal(id, (db) => { db.saveSnapshot(0, payload, PERSON); db.append(1, payload, 'move', PERSON); });
  /** Return status/body without ever placing credentials in diagnostic text or URLs. */
  async function call(id, { path = '/state', method = 'GET', token = signed.token, body } = {}) {
    const response = await fetch('http://127.0.0.1:' + relay.port + '/api/v1/boards' + (id ? '/' + id + path : ''), {
      method, headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  return { root, data, backups, auth, signed, agent, other, config, retention, relay, payload, marker, key, journal, call,
    set(value) { clock = value; }, at: () => clock, advance(days) { clock += days * DAY; } };
}

test('[H18] warnings begin at sixty days on authorized contact; compaction and restart preserve activity', async (t) => {
  const box = await fixture(t);
  const start = box.at();
  box.set(start + 60 * DAY - 1);
  assert.equal((await box.call(A)).body.state.warning, undefined);
  box.advance(1 / DAY);
  const warned = await box.call(A);
  assert.equal(warned.status, 200);
  assert.equal(warned.body.state.warning.code, 'BOARD_INACTIVE');
  assert.equal(warned.body.state.warning.inactiveDays, 60);
  assert.equal(warned.body.state.warning.deletesAt, new Date(start + 90 * DAY).toISOString());
  assert.equal((await box.call(null)).body.warnings.length, 2);
  const snapshot = await box.call(A, { method: 'PUT', body: { sequence: 1, sealed: box.payload.toString('base64url') } });
  assert.equal(snapshot.body.state.warning.inactiveDays, 60, 'snapshot upload does not reset inactivity');
  assert.equal(box.journal(A, (db) => db.after(0).length), 0, 'all covered history is folded into the snapshot');
  const restarted = createRelayRetention(box.config);
  assert.equal(restarted.notice(A).deletesAt, new Date(start + 90 * DAY).toISOString());
  const move = await box.call(A, { method: 'POST', path: '/moves', token: box.agent.token, body: { sequence: 2, sealed: box.payload.toString('base64url') } });
  assert.equal(move.status, 200);
  assert.equal((await box.call(A)).body.state.warning, undefined, 'a new sealed record resets the warning');
  assert.equal(restarted.notice(A), null);
  const before = readdirSync(box.data);
  const crossed = await box.call(B, { token: box.agent.token });
  assert.equal(crossed.status, 403);
  assert.deepEqual(readdirSync(box.data), before, 'unauthorized contact cannot mutate retention');
});

test('[H18] ninety-day expiry unlinks data and credentials while preserving the other board and person session', async (t) => {
  const box = await fixture(t);
  box.advance(89);
  assert.equal((await box.call(A)).status, 200);
  box.journal(B, (db) => db.append(2, box.payload, 'move', PERSON));
  box.advance(1);
  const expired = await box.call(A);
  assert.equal(expired.status, 404);
  for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(join(box.data, A + '.journal.sqlite' + suffix)), false);
  assert.equal((await box.call(A, { token: box.agent.token })).status, 401);
  assert.equal((await box.call(B, { token: box.other.token })).status, 200);
  assert.equal((await box.auth.authenticate(box.signed.token)).kind, 'session');
  assert.deepEqual(box.auth.linkedBoards().map((row) => row.id), [B]);
  assert.deepEqual(box.auth.pendingCleanup(), []);
});

test('[H18] explicit unlink removes managed backups immediately and a durable crash intent is finished after restart', async (t) => {
  const box = await fixture(t);
  const saved = box.retention.backup();
  assert.equal(saved.written.length, 2);
  const removed = await box.call(A, { method: 'DELETE', path: '' });
  assert.equal(removed.status, 200);
  assert.equal(readdirSync(box.backups).some((name) => name.startsWith(A)), false);
  assert.equal(readdirSync(box.backups).some((name) => name.startsWith(B)), true);
  // Model a process crash after committing revocation but before deleting any files.
  box.auth.forgetBoard(B);
  assert.ok(existsSync(join(box.data, B + '.journal.sqlite')));
  assert.deepEqual(box.auth.pendingCleanup(), [B]);
  await assert.rejects(box.auth.authenticate(box.other.token, { board: B }), { code: 'AUTH_REQUIRED' });
  await assert.rejects(box.auth.linkBoard(box.signed.token, B, 'fixture/repository'), { code: 'RELAY_CLEANUP' });
  const freshAuth = createRelayAuth({ database: join(box.root, 'auth.sqlite'), github: {} });
  try {
    assert.deepEqual(freshAuth.pendingCleanup(), [B], 'the intent comes from persisted auth state');
    const restarted = createRelayRetention({ ...box.config, auth: freshAuth });
    restarted.maintain();
    assert.equal(existsSync(join(box.data, B + '.journal.sqlite')), false);
    assert.deepEqual(readdirSync(box.backups), []);
    assert.deepEqual(freshAuth.pendingCleanup(), []);
  } finally { freshAuth.close(); }
  await box.auth.linkBoard(box.signed.token, B, 'fixture/repository');
});

test('[H18] SQLite backups contain current compacted state, stay private, and prune only after fourteen days', async (t) => {
  const box = await fixture(t);
  box.journal(A, (db) => { db.append(2, box.payload, 'move', PERSON); db.saveSnapshot(1, box.payload, PERSON); });
  const at = box.at();
  let saved;
  box.auth.withBoard(A, () => {
    const active = createRelayJournal({ directory: box.data, boardId: A, now: () => new Date(box.at()) });
    try {
      active.append(3, box.payload, 'move', PERSON);
      assert.ok(existsSync(join(box.data, A + '.journal.sqlite-wal')), 'the source has live committed WAL contents');
      saved = box.retention.backup();
    } finally { active.close(); }
  });
  const name = A + '.' + at + '.sqlite';
  assert.ok(saved.written.includes(name));
  assert.equal(statSync(box.backups).mode & 0o777, 0o700);
  assert.equal(statSync(join(box.backups, name)).mode & 0o777, 0o600);
  const copy = new DatabaseSync(join(box.backups, name), { readOnly: true });
  try {
    assert.equal(copy.prepare('SELECT sequence FROM journal_head').get().sequence, 3);
    assert.equal(copy.prepare('SELECT sequence FROM journal_snapshot').get().sequence, 1);
    assert.deepEqual(copy.prepare('SELECT sequence FROM journal_record').all().map((row) => row.sequence), [2, 3]);
    assert.deepEqual(Buffer.from(copy.prepare('SELECT payload FROM journal_snapshot').get().payload), box.payload);
  } finally { copy.close(); }
  for (const file of readdirSync(box.backups)) {
    const bytes = readFileSync(join(box.backups, file));
    assert.equal(bytes.includes(box.key), false);
    assert.equal(bytes.includes(Buffer.from(box.marker)), false);
  }
  writeFileSync(join(box.backups, 'operator.txt'), 'keep', { mode: 0o600 });
  box.advance(14);
  assert.deepEqual(box.retention.prune(), []);
  box.set(box.at() + 1);
  assert.equal(box.retention.prune().length, 2);
  assert.deepEqual(readdirSync(box.backups), ['operator.txt']);
});

test('[H18] maintenance is daily, retries storage failures, and refuses symlink or invalid-clock deletion', async (t) => {
  const box = await fixture(t);
  const first = box.relay.maintenance();
  assert.equal(first.written.length, 2);
  assert.equal(box.relay.maintenance().written.length, 0);
  box.advance(1);
  assert.equal(box.relay.maintenance().written.length, 2);
  const outside = join(box.root, 'outside');
  writeFileSync(outside, 'keep', { mode: 0o600 });
  const link = join(box.backups, A + '.0.sqlite');
  symlinkSync(outside, link);
  assert.throws(() => box.relay.maintenance(), { code: 'RELAY_STORAGE' });
  assert.deepEqual(box.relay.maintenanceStatus(), { error: 'RELAY_STORAGE' });
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
  rmSync(link);
  assert.doesNotThrow(() => box.relay.maintenance());
  assert.deepEqual(box.relay.maintenanceStatus(), { error: null });
  const before = readdirSync(box.backups);
  box.set(NaN);
  assert.throws(() => box.retention.maintain(), { code: 'RELAY_CLOCK' });
  assert.deepEqual(readdirSync(box.backups), before);
});

test('[H18] a never-uploaded link expires from its original link time without manufacturing a journal', async (t) => {
  const box = await fixture(t);
  const C = 'c'.repeat(32);
  await box.auth.linkBoard(box.signed.token, C, 'fixture/repository');
  const linked = box.auth.linkedBoards().find((row) => row.id === C).linkedAt;
  box.set(linked + 60 * DAY);
  assert.equal(box.retention.notice(C).inactiveDays, 60);
  assert.equal(existsSync(join(box.data, C + '.journal.sqlite')), false);
  box.set(linked + 90 * DAY);
  assert.equal(box.retention.expire(C), true);
  assert.equal(box.auth.linkedBoards().some((row) => row.id === C), false);
  assert.equal(existsSync(join(box.data, C + '.journal.sqlite')), false);
});


test('[H18] a move holding the shared process lock refreshes activity before an expiry decision', async (t) => {
  const box = await fixture(t);
  const code = `
    import { createRelayAuth } from ${JSON.stringify(new URL('../relay/auth.js', import.meta.url).href)};
    import { createRelayJournal } from ${JSON.stringify(new URL('../relay/journal.js', import.meta.url).href)};
    import { createRelayRetention } from ${JSON.stringify(new URL('../relay/retention.js', import.meta.url).href)};
    const [database, directory, backupsDirectory, board, clock] = process.argv.slice(1);
    const auth = createRelayAuth({ database, github: {} });
    const now = Number(clock);
    process.send({ kind: 'ready' });
    process.once('message', (command) => {
      try {
        if (command === 'append') auth.withBoard(board, () => {
          process.send({ kind: 'locked' });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
          const journal = createRelayJournal({ directory, boardId: board, now: () => new Date(now + 89 * 86400000) });
          try { journal.append(2, Uint8Array.of(3, 4, 5), 'move', { kind: 'person', userId: '7' }); }
          finally { journal.close(); }
          process.send({ kind: 'appended' });
        });
        else {
          const retention = createRelayRetention({ directory, backupsDirectory, auth, now: () => now + 90 * 86400000 });
          process.send({ kind: 'expired', value: retention.expire(board) });
        }
      } catch (error) { process.send({ kind: 'failed', code: error.code ?? 'NATIVE' }); }
      finally { auth.close(); process.disconnect(); }
    });`;
  /** Launch only our fixture worker; capture safe IPC records and never raw credentials or payloads. */
  function worker() {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, join(box.root, 'auth.sqlite'), box.data, box.backups, A, String(box.at())], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const messages = [];
    const waiters = new Set();
    child.on('message', (value) => { messages.push(value); for (const wake of waiters) wake(); });
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    /** Await a specific worker phase with a bounded deadline, without relying on a startup sleep. */
    function phase(kind) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error('fixture worker phase timed out')); }, 10_000);
        /** Resolve only the requested safe phase, and surface a fixed refusal code on worker failure. */
        function check() {
          const failure = messages.find((entry) => entry.kind === 'failed');
          const result = messages.find((entry) => entry.kind === kind);
          if (!failure && !result) return;
          clearTimeout(timer); waiters.delete(check);
          if (failure) reject(new Error('fixture worker refused: ' + failure.code)); else resolve(result);
        }
        waiters.add(check); check();
      });
    }
    return { child, phase };
  }
  const holder = worker();
  const expiry = worker();
  await Promise.all([holder.phase('ready'), expiry.phase('ready')]);
  holder.child.send('append');
  await holder.phase('locked');
  expiry.child.send('expire');
  assert.equal((await expiry.phase('expired')).value, false);
  await holder.phase('appended');
  assert.equal(box.journal(A, (db) => db.latest()), 2);
  assert.ok(existsSync(join(box.data, A + '.journal.sqlite')));
  // A stale cleaner must do nothing after intent completion and relinking.
  box.retention.unlink(A);
  await box.auth.linkBoard(box.signed.token, A, 'fixture/repository');
  box.journal(A, (db) => db.saveSnapshot(0, box.payload, PERSON));
  let staleCleanerRan = false;
  box.auth.withCleanup(A, () => { staleCleanerRan = true; });
  assert.equal(staleCleanerRan, false);
  assert.ok(existsSync(join(box.data, A + '.journal.sqlite')));
});
