/** The runner tooling capsule travels on stdin, never in the SSH exec command, whose size OpenSSH bounds at 256 KiB [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteWorkerLaunch } from '../packages/runners/src/shell/runner-remote-tooling.js';

/** OpenSSH resets a session whose exec request exceeds its 256 KiB packet bound. */
const SSH_PACKET_LIMIT = 256 * 1024;

/** A runtime whose compressed capsule alone exceeds the SSH bound, plus a worker that echoes the rest of stdin. */
function largeTooling() {
  const entry = 'src/runner-worker.js';
  const worker = "process.stdin.pipe(process.stdout);\n";
  // Random base64 barely compresses, so the gzip+base64 payload stays well above 256 KiB.
  const runtimeFiles = { 'src/bulk.js': `export const bulk = ${JSON.stringify(randomBytes(300 * 1024).toString('base64'))};\n` };
  const files = Object.fromEntries(Object.entries({ ...runtimeFiles, [entry]: worker }).sort(([a], [b]) => a.localeCompare(b)));
  const sha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { entry, worker, tooling: { sha256 }, runtime: { entry, files: runtimeFiles } };
}

test('clause 1: the worker command stays far below the SSH packet bound however large the capsule is [C7]', () => {
  const { worker, tooling, runtime } = largeTooling();
  const { command, input } = remoteWorkerLaunch({ host: 'runner', node: process.execPath }, worker, tooling, runtime, '', null);
  assert.ok(input.length > SSH_PACKET_LIMIT, 'the fixture capsule must be larger than the SSH bound');
  assert.ok(Buffer.byteLength(command) < 16 * 1024, `command is ${Buffer.byteLength(command)} bytes`);
  assert.ok(!command.includes(input.subarray(20, 80).toString('ascii')), 'the capsule payload never appears in the command');
});

test('clause 2: a capsule larger than the SSH bound installs from stdin and the worker reads exactly the bytes after it [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-capsule-'));
  try {
    const { entry, worker, tooling, runtime } = largeTooling();
    const { command, input } = remoteWorkerLaunch({ host: 'runner', node: process.execPath, root }, worker, tooling, runtime, '', null);
    const frame = Buffer.from('12\n{"job":"x"}');
    const result = spawnSync('/bin/sh', ['-c', command], { input: Buffer.concat([input, frame]), maxBuffer: 1024 ** 2 });
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(result.stdout.toString(), frame.toString());
    assert.equal(readFileSync(join(root, 'runtime', tooling.sha256, entry), 'utf8'), worker);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clause 3: the file passes, including a truncated capsule fails before the worker starts [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-capsule-'));
  try {
    const { worker, tooling, runtime } = largeTooling();
    const { command, input } = remoteWorkerLaunch({ host: 'runner', node: process.execPath, root }, worker, tooling, runtime, '', null);
    const result = spawnSync('/bin/sh', ['-c', command], { input: input.subarray(0, input.length - 10), maxBuffer: 1024 ** 2 });
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /runner capsule ended early/u);
    assert.equal(result.stdout.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
