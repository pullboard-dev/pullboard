/**
 * A resident board process never outlives the socket it serves and never deletes a successor's socket [H24]. On
 * 4 November 38 orphaned residents (6 GB) piled up on the coordinator's Mac: a busy resident refused a connect, a
 * successor took its path, and each orphan, retiring later, unlinked the live socket and started the cycle again.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

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

/** Fail after a bound instead of hanging the run. */
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, fail) => setTimeout(() => fail(new Error(`${what} within ${ms} ms`)), ms))]);

test('a resident whose socket path another process now owns exits, leaving the successor socket in place [H24]', async () => {
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
    const { code } = await within(first.exited, 5_000, 'the orphaned resident exits');
    assert.equal(code, 0);
    assert.equal(existsSync(socket), true, 'the successor socket survives the orphan retiring');
    assert.equal(identity(socket), theirs);
  } finally {
    first.child.kill('SIGKILL');
    await new Promise(done => successor.close(done));
  }
});

test('a new resident never takes the path of a live resident that refused its probe [H24]', async () => {
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

test('a new resident takes the path when the recorded holder is gone [H24]', async () => {
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
