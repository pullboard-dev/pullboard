/** The relay lock has one holder at a time, even when many waiters find the same dead owner [H5]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const LOCK_MODULE = new URL('../../../src/io/relay/lock.js', import.meta.url).href;

/**
 * A process number no process can hold: far above any system's limit. Not one that just exited, nor a free one in the
 * usual range: the system may hand either to one of the waiters, and the lock's owner would then look alive.
 */
function deadPid() {
  const pid = 2_147_483_000;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return pid; throw error; }
  throw new Error('the dead owner\'s process number is in use');
}

/** One waiter: take the lock, note entry and exit in the shared log, and hold it briefly. */
const WAITER = `
import { appendFileSync } from 'node:fs';
const { locked } = await import(process.argv[1]);
const [log, file] = process.argv.slice(2);
await locked(file, async () => {
  appendFileSync(log, 'enter ' + process.pid + '\\n');
  await new Promise(done => setTimeout(done, 30));
  appendFileSync(log, 'exit ' + process.pid + '\\n');
});
`;

/** Run six waiters against a dead owner's lock, optionally with a dead holder's lease too, and check one holder. */
async function round(root, index, { deadLease = false } = {}) {
  const file = join(root, `relay-${index}.json`);
  const log = join(root, `log-${index}`);
  writeFileSync(log, '');
  // The lock a crashed command left behind: its owner's process is gone.
  mkdirSync(`${file}.lock`);
  writeFileSync(join(`${file}.lock`, 'pid'), String(deadPid()));
  if (deadLease) {
    // And the lease of a command that died holding it.
    const db = new DatabaseSync(`${file}.lease.sqlite`);
    db.exec('CREATE TABLE IF NOT EXISTS relay_lease(name TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL)');
    db.prepare("INSERT INTO relay_lease(name, pid, token) VALUES ('relay', ?, 'dead')").run(deadPid());
    db.close();
  }
  const waiters = Array.from({ length: 6 }, () => new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', WAITER, LOCK_MODULE, log, file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', part => { stderr += part; });
    child.once('exit', code => (code === 0 ? done() : fail(new Error(stderr))));
  }));
  await Promise.all(waiters);
  let holders = 0;
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  for (const line of lines) {
    holders += line.startsWith('enter') ? 1 : -1;
    assert.ok(holders <= 1, `round ${index}: two waiters held the lock at once:\n${lines.join('\n')}`);
  }
  assert.equal(lines.filter(line => line.startsWith('enter')).length, 6, `round ${index}: every waiter held the lock once`);
}

test('waiters on a dead owner leave exactly one holder at a time [H5]', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-relay-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 15; index += 1) await round(root, index);
});

test('a lease left by a dead holder is taken over by one waiter at a time [H5]', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-relay-lock-lease-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 10; index += 1) await round(root, index, { deadLease: true });
});

test('a lock left with no owner by a command that died making it is recovered once it is old [H5]', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-relay-lock-unowned-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'relay.json');
  const log = join(root, 'log');
  writeFileSync(log, '');
  // The command made the directory and died before writing its pid; the lock is past the stale age.
  mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(`${file}.lock`, old, old);
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', WAITER, LOCK_MODULE, log, file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', part => { stderr += part; });
    child.once('exit', code => (code === 0 ? done() : fail(new Error(stderr))));
  });
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').filter(line => line.startsWith('enter')).length, 1, 'the waiter took the recovered lock');
});
