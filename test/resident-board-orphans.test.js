/**
 * A resident board process never outlives the socket it serves and never deletes a successor's socket [H24]. On
 * 4 November 38 orphaned residents (6 GB) piled up on the coordinator's Mac: a busy resident refused a connect, a
 * successor took its path, and each orphan, retiring later, unlinked the live socket and started the cycle again.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { endThen, releaseOwnSocket } from '../bin/resident-socket.js';

const ENTRY = resolve(import.meta.dirname, '..', 'bin', 'resident-board.js');
const dir = mkdtempSync(join(tmpdir(), 'pb-res-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const identity = (path) => { const stat = statSync(path); return `${stat.dev}:${stat.ino}`; };

/** Start a resident at a socket path and resolve once it has exited, with its exit code and stderr. */
function resident(socket, pid, env = {}) {
  const child = spawn(process.execPath, [ENTRY, socket, ENTRY, 'commit:test', pid],
    { env: { ...process.env, PULLBOARD_RESIDENT_REPLACED_CHECK_MS: '100', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const listening = new Promise((done) => { child.stdout.on('data', () => { if (stdout.includes('listening')) done(); }); });
  const exited = new Promise(done => child.on('exit', code => done({ code, stderr })));
  return { child, listening, exited };
}

/** Fail after a bound instead of hanging the run, clearing the bound once the promise settles. */
function within(promise, ms, what) {
  let timer;
  const bound = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${what} within ${ms} ms`)), ms); });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

/** Listen at a Unix socket path and resolve the server once it is bound. */
async function listenAt(path, onConnection = () => {}) {
  const server = createServer(onConnection);
  await new Promise(done => server.listen(path, done));
  return server;
}

/** Whether a client can connect at the path now. */
const reachable = path => new Promise(done => {
  const client = connect(path);
  client.once('connect', () => { client.destroy(); done(true); });
  client.once('error', () => done(false));
});

test('a resident whose socket path another process now owns exits, leaving the successor socket in place [C7,H24]', async () => {
  const socket = join(dir, 'a.sock');
  const pid = join(dir, 'a.pid');
  const first = resident(socket, pid);
  await within(first.listening, 15_000, 'the resident listens');
  // A successor takes the path, as a client-started process does when a connect is refused.
  rmSync(socket);
  const successor = createServer(() => {});
  await new Promise(done => successor.listen(socket, done));
  const theirs = identity(socket);
  try {
    const { code } = await within(first.exited, 5_000, 'the orphaned resident exits within 5 s');
    assert.equal(code, 0);
    assert.equal(existsSync(socket), true, 'the successor socket survives the orphan retiring');
    assert.equal(identity(socket), theirs);
  } finally {
    first.child.kill('SIGKILL');
    await new Promise(done => successor.close(done));
  }
});

test('a new resident never takes the path of a live resident that refused its probe [C7,H24]', async () => {
  // A plain file at the path refuses every connect, as a full backlog does, and the pid file names a live process.
  const socket = join(dir, 'b.sock');
  const pid = join(dir, 'b.pid');
  writeFileSync(socket, '');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  writeFileSync(pid, `${holder.pid}\n`);
  const before = identity(socket);
  try {
    const next = resident(socket, pid);
    const { code, stderr } = await within(next.exited, 15_000, 'the second resident exits');
    assert.equal(code, 0);
    assert.match(stderr, /alive but busy/u);
    assert.equal(identity(socket), before, 'the live resident keeps its path');
  } finally { holder.kill('SIGKILL'); }
});

test('a new resident takes the path when the recorded holder is gone [C7,H24]', async () => {
  const socket = join(dir, 'c.sock');
  const pid = join(dir, 'c.pid');
  writeFileSync(socket, '');
  writeFileSync(pid, '999999\n');
  const next = resident(socket, pid);
  try {
    await within(next.listening, 15_000, 'the resident takes the stale path and listens');
  } finally {
    next.child.kill('SIGTERM');
    await next.exited;
  }
});

test('releasing the socket removes only this process\'s own socket, even when a successor took the path before the check [C7,H24]', async () => {
  const path = join(dir, 'd.sock');
  const mine = await listenAt(path);
  const own = identity(path);
  // The successor takes the path after this process last looked and before it releases: the race a stat-then-unlink loses.
  rmSync(path);
  const successor = await listenAt(path);
  const theirs = identity(path);
  try {
    assert.equal(releaseOwnSocket(path, own, 'd'), false);
    assert.equal(identity(path), theirs, 'the successor keeps its socket at the path');
    assert.equal(await reachable(path), true, 'the successor still answers at the path');
    assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('d.sock.')), [], 'no moved-aside file is left');
  } finally {
    await new Promise(done => successor.close(done));
    await new Promise(done => mine.close(done));
  }
  const again = await listenAt(join(dir, 'e.sock'));
  const ownAgain = identity(join(dir, 'e.sock'));
  assert.equal(releaseOwnSocket(join(dir, 'e.sock'), ownAgain, 'e'), true);
  assert.equal(existsSync(join(dir, 'e.sock')), false, 'a process\'s own socket is removed');
  assert.equal(releaseOwnSocket(join(dir, 'e.sock'), ownAgain, 'e'), false, 'an empty path is left alone');
  await new Promise(done => again.close(done));
});

test('a retiring process\'s last response is written in full before it may exit [C7,H24]', async () => {
  const path = join(dir, 'f.sock');
  const payload = 'x'.repeat(4 * 1024 * 1024);
  let flushedAt = null;
  let served;
  const queued = new Promise(done => { served = done; });
  const server = await listenAt(path, socket => {
    socket.write(payload);
    endThen(socket, '{"t":"exit","code":0}\n', () => { flushedAt = received; });
    served(socket.writableLength);
  });
  let received = 0;
  const client = connect(path);
  client.pause();
  try {
    await new Promise(done => client.once('connect', done));
    // The client reads nothing yet, so the response is queued: an exit now would cut it off.
    assert.ok(await within(queued, 5_000, 'the server answers') > 0, 'the response is still queued');
    assert.equal(flushedAt, null, 'a queued response holds the exit');
    const text = await new Promise(done => {
      let all = '';
      client.setEncoding('utf8').on('data', chunk => { all += chunk; received += chunk.length; }).on('end', () => done(all));
      client.resume();
    });
    assert.equal(text.length, payload.length + '{"t":"exit","code":0}\n'.length);
    assert.ok(text.endsWith('{"t":"exit","code":0}\n'), 'the last frame arrives whole');
    await within(new Promise(done => { const wait = () => flushedAt !== null ? done() : setImmediate(wait); wait(); }), 5_000, 'the flush is reported');
  } finally {
    client.destroy();
    await new Promise(done => server.close(done));
  }
  let calls = 0;
  const gone = connect(path);
  gone.on('error', () => {});
  gone.destroy();
  await within(new Promise(done => endThen(gone, 'late\n', () => { calls++; done(); })), 5_000, 'a gone client releases the exit');
  assert.equal(calls, 1, 'a client that already left releases the exit once');
});

test('an owner retiring idle frees its own path and exits [C7,H24]', async () => {
  const socket = join(dir, 'g.sock');
  const pid = join(dir, 'g.pid');
  const owner = resident(socket, pid, { PULLBOARD_RESIDENT_IDLE_MS: '200' });
  try {
    await within(owner.listening, 15_000, 'the resident listens');
    const { code } = await within(owner.exited, 15_000, 'the idle resident exits');
    assert.equal(code, 0);
    assert.equal(existsSync(socket), false, 'its own socket is removed for a successor');
    assert.equal(existsSync(pid), false, 'its pid file is removed');
  } finally { owner.child.kill('SIGKILL'); }
});
