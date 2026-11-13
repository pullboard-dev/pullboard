/** @pullboard-test-input apps/cli/src/io/resident/board.js apps/cli/src/io/resident/socket.js */
/**
 * A resident board process never outlives the socket it serves and never deletes a successor's socket [H24]. On
 * 4 November 38 orphaned residents (6 GB) piled up on the coordinator's Mac: a busy resident refused a connect, a
 * successor took its path, and each orphan, retiring later, unlinked the live socket and started the cycle again.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  connect,
  createServer,
} from 'node:net';
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  endThen,
  flushesDue,
  lockPath,
  releaseOwnSocket,
} from '../../../../src/io/resident/socket.js';

const ENTRY = resolve(import.meta.dirname, '../../../../src/io/resident/board.js');
// Unix socket paths are limited to about 104 bytes on macOS, and a runner's job temp folder alone is longer, so the
// sockets live in a short private folder under /tmp, as the resident client's own fallback does (#3168).
const dir = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'pb-res-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const identity = (path) => { const stat = statSync(path); return `${stat.dev}:${stat.ino}`; };

/** Every resident this file starts, so the last case can prove none outlives the file. */
const started = [];

/** Start a resident at a socket path and resolve once it has exited, with its exit code and stderr. */
function resident(socket, pid, env = {}) {
  const child = spawn(process.execPath, [ENTRY, socket, ENTRY, 'commit:test', pid],
    { env: { ...process.env, PULLBOARD_RESIDENT_REPLACED_CHECK_MS: '100', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const listening = new Promise((done) => { child.stdout.on('data', () => { if (stdout.includes('listening')) done(); }); });
  const exited = new Promise(done => child.on('exit', code => done({ code, stderr })));
  started.push(exited);
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

const SOCKET_MODULE = new URL('../../../../src/io/resident/socket.js', import.meta.url).href;

/** A separate process that tries the path lock and holds it if taken, reporting which. */
async function lockHolder(path, { expectLocked = true } = {}) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', [
    `const { lockPath } = await import(${JSON.stringify(SOCKET_MODULE)});`,
    `const unlock = lockPath(${JSON.stringify(path)});`,
    "process.stdout.write(unlock ? 'locked\\n' : 'busy\\n');",
    "process.stdin.on('end', () => { unlock?.(); process.exit(0); }).resume();",
  ].join('\n')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise(done => child.on('exit', done));
  const answer = await within(new Promise(done => child.stdout.setEncoding('utf8').on('data', chunk => done(chunk.trim()))), 15_000, 'the lock holder answers');
  if (expectLocked) assert.equal(answer, 'locked');
  return { child, exited, locked: answer === 'locked', stop: async () => { child.stdin.end(); await exited; } };
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
    assert.equal(releaseOwnSocket(path, own, join(dir, 'd.pid')), false);
    assert.equal(identity(path), theirs, 'the successor keeps its socket at the path');
    assert.equal(await reachable(path), true, 'the successor still answers at the path');
    assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('d.sock.') && name !== 'd.sock.lock'), [], 'nothing else is left beside it');
  } finally {
    await new Promise(done => successor.close(done));
    await new Promise(done => mine.close(done));
  }
  const again = await listenAt(join(dir, 'e.sock'));
  const ownAgain = identity(join(dir, 'e.sock'));
  const epid = join(dir, 'e.pid');
  writeFileSync(epid, `${process.pid}\n`);
  // While another live process holds the path lock, even this process's own socket and pid file stay.
  const holder = await lockHolder(join(dir, 'e.sock'));
  try {
    assert.equal(releaseOwnSocket(join(dir, 'e.sock'), ownAgain, epid), false);
    assert.equal(identity(join(dir, 'e.sock')), ownAgain, 'a busy lock leaves the path as it is');
    assert.equal(existsSync(epid), true, 'and the pid file');
  } finally { await holder.stop(); }
  assert.equal(releaseOwnSocket(join(dir, 'e.sock'), ownAgain, epid), true);
  assert.equal(existsSync(join(dir, 'e.sock')), false, 'a process\'s own socket is removed');
  assert.equal(existsSync(epid), false, 'with its own pid file');
  writeFileSync(epid, '999999\n');
  assert.equal(releaseOwnSocket(join(dir, 'e.sock'), ownAgain, epid), false, 'an empty path is left alone');
  assert.equal(readFileSync(epid, 'utf8'), '999999\n', 'another process\'s pid file is left alone');
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

test('clause 1: two residents starting at one stale path at once leave exactly one listening there [C7,H24]', async () => {
  const socket = join(dir, 'h.sock');
  const pid = join(dir, 'h.pid');
  writeFileSync(socket, '');
  writeFileSync(pid, '999999\n');
  const starters = [resident(socket, pid), resident(socket, pid)];
  try {
    const winner = await within(Promise.race(starters.map((one, index) => one.listening.then(() => index))), 15_000, 'one resident listens');
    const loser = starters[1 - winner];
    const { code } = await within(loser.exited, 15_000, 'the other resident exits');
    assert.equal(code, 0);
    assert.equal(starters[winner].child.exitCode, null, 'the resident that took the path still runs');
    assert.equal(await reachable(socket), true, 'its socket is still at the path');
    assert.equal(readFileSync(pid, 'utf8').trim(), String(starters[winner].child.pid));
  } finally {
    for (const one of starters) one.child.kill('SIGKILL');
    await Promise.all(starters.map(one => one.exited));
  }
});

test('the path lock is exclusive while its holder lives and free once it dies, with nothing to break [C7,H24]', async () => {
  const path = join(dir, 'i.sock');
  const holder = await lockHolder(path);
  try { assert.equal(lockPath(path), null, 'a live holder keeps its lock'); }
  finally { holder.child.kill('SIGKILL'); await holder.exited; }
  const unlock = lockPath(path);
  assert.equal(typeof unlock, 'function', 'a killed holder\'s lock is free');
  const second = await lockHolder(path, { expectLocked: false });
  try { assert.equal(second.locked, false, 'another process cannot take it meanwhile'); }
  finally { await second.stop(); }
  unlock();
  unlock();
  const after = lockPath(path);
  assert.equal(typeof after, 'function', 'a released lock is free');
  after();
});

test('an orphaned resident finishes the client response in flight, then exits within 5 s [C7,H24]', async () => {
  const socket = join(dir, 'j.sock');
  const pid = join(dir, 'j.pid');
  const traceFile = join(dir, 'j.trace');
  const work = mkdtempSync(join(tmpdir(), 'pb-res-work-'));
  const received = join(work, 'received.txt');
  const orphan = resident(socket, pid, { PULLBOARD_RESIDENT_TRACE: traceFile });
  let successor;
  let client;
  try {
    await within(orphan.listening, 15_000, 'the resident listens');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PULLBOARD_RESIDENT')));
    const request = JSON.stringify({ code: 'commit:test', argv: ['help', '--all'], cwd: work, env, tty: {} }) + '\n';
    // A separate client process, stopped once its request is sent, reads nothing: the response stays queued in the resident.
    client = spawn(process.execPath, ['-e', [
      "const net = require('node:net'); const fs = require('node:fs');",
      'const [path, request, out] = process.argv.slice(1); let text = "";',
      "const socket = net.connect(path, () => socket.write(request, () => process.stdout.write('sent\\n')));",
      "socket.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('end', () => fs.writeFileSync(out, text));",
    ].join('\n'), socket, request, received], { stdio: ['ignore', 'pipe', 'inherit'] });
    const clientDone = new Promise(done => client.on('exit', done));
    await within(new Promise(done => client.stdout.on('data', chunk => { if (String(chunk).includes('sent')) done(); })), 15_000, 'the client sends');
    client.kill('SIGSTOP');
    const traced = event => { try { return readFileSync(traceFile, 'utf8').includes(event); } catch { return false; } };
    const seen = event => new Promise(done => { const look = () => traced(event) ? done() : setImmediate(look); look(); });
    await within(seen('respond:exit'), 15_000, 'the command finishes and its response is queued');
    // A successor takes the path, as when a connect was refused.
    rmSync(socket);
    successor = await listenAt(socket);
    // The 5 s bound starts at the takeover and covers finishing the response.
    const exitedInTime = within(orphan.exited, 5_000, 'the orphan exits within 5 s of the takeover');
    exitedInTime.catch(() => {});
    await within(seen('retire:replaced'), 5_000, 'the orphan retires');
    client.kill('SIGCONT');
    await within(clientDone, 5_000, 'the client reads the whole response');
    const frames = readFileSync(received, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(frames.at(-1), { t: 'exit', code: 0 }, 'the last frame arrives whole');
    assert.ok(frames.filter(frame => frame.t === 'out').map(frame => frame.d).join('').length > 30_000, 'the whole output arrives');
    const { code } = await exitedInTime;
    assert.equal(code, 0);
  } finally {
    client?.kill('SIGCONT');
    client?.kill('SIGKILL');
    orphan.child.kill('SIGKILL');
    if (successor) await new Promise(done => successor.close(done));
    rmSync(work, { recursive: true, force: true });
  }
});

test('an orphaned resident whose client never reads its response still exits within 5 s of the takeover [C7,H24]', async () => {
  const socket = join(dir, 'k.sock');
  const pid = join(dir, 'k.pid');
  const traceFile = join(dir, 'k.trace');
  const work = mkdtempSync(join(tmpdir(), 'pb-res-work-'));
  const orphan = resident(socket, pid, { PULLBOARD_RESIDENT_TRACE: traceFile });
  let successor;
  let client;
  try {
    await within(orphan.listening, 15_000, 'the resident listens');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PULLBOARD_RESIDENT')));
    const request = JSON.stringify({ code: 'commit:test', argv: ['help', '--all'], cwd: work, env, tty: {} }) + '\n';
    client = spawn(process.execPath, ['-e', [
      "const net = require('node:net');",
      "const socket = net.connect(process.argv[1], () => socket.write(process.argv[2], () => process.stdout.write('sent\\n')));",
      "socket.on('data', () => {});",
    ].join('\n'), socket, request], { stdio: ['ignore', 'pipe', 'inherit'] });
    await within(new Promise(done => client.stdout.on('data', chunk => { if (String(chunk).includes('sent')) done(); })), 15_000, 'the client sends');
    client.kill('SIGSTOP');
    const traced = event => { try { return readFileSync(traceFile, 'utf8').includes(event); } catch { return false; } };
    await within(new Promise(done => { const look = () => traced('respond:exit') ? done() : setImmediate(look); look(); }), 15_000, 'the response is queued');
    rmSync(socket);
    successor = await listenAt(socket);
    const { code } = await within(orphan.exited, 5_000, 'the orphan exits within 5 s of the takeover');
    assert.equal(code, 0);
  } finally {
    client?.kill('SIGCONT');
    client?.kill('SIGKILL');
    orphan.child.kill('SIGKILL');
    if (successor) await new Promise(done => successor.close(done));
    rmSync(work, { recursive: true, force: true });
  }
});

test('a resident that cannot record itself in the pid file gives up its socket instead of serving unnamed [C7,H24]', async () => {
  const socket = join(dir, 'l.sock');
  const pid = join(dir, 'missing-folder', 'l.pid');
  const unnamed = resident(socket, pid);
  const { code, stderr } = await within(unnamed.exited, 15_000, 'the resident exits');
  assert.equal(code, 0);
  assert.match(stderr, /cannot record the resident process/u);
  assert.equal(existsSync(socket), false, 'its socket is removed, so a starter binds a free path');
  const unlock = lockPath(socket);
  assert.equal(typeof unlock, 'function', 'and the path lock is free');
  unlock();
});

test('a response queued after retirement, by a command that ran long, gets its own whole flush window [C7,H24]', () => {
  const retiredAt = 1_000;
  assert.equal(flushesDue([], retiredAt, retiredAt, 2_000), true, 'nothing pending exits at once');
  assert.equal(flushesDue([{ at: 500 }], retiredAt, 2_999, 2_000), false, 'a response queued before retiring waits from the retirement');
  assert.equal(flushesDue([{ at: 500 }], retiredAt, 3_000, 2_000), true);
  // The running command finished 5 s after retirement: its response is not overdue just because the retirement is old.
  assert.equal(flushesDue([{ at: 6_000 }], retiredAt, 6_001, 2_000), false);
  assert.equal(flushesDue([{ at: 6_000 }], retiredAt, 8_000, 2_000), true);
  assert.equal(flushesDue([{ at: 500 }, { at: 6_000 }], retiredAt, 7_000, 2_000), false, 'every pending response must be due');
});

test('clause 2: every resident this file started has exited, so the file finishes within its time limit [C7,H24]', async () => {
  assert.ok(started.length > 0);
  await within(Promise.all(started), 5_000, 'every resident started here exits');
});
