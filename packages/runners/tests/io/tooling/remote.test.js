/** @pullboard-test-input source-cell apps/runner packages/runners */
/** The runner tooling capsule travels on stdin, never in the SSH exec command, whose size OpenSSH bounds at 256 KiB [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteWorkerLaunch } from '../../../src/io/tooling/remote.js';
import { CAPSULE_STDIN_LIMIT } from '../../../src/io/tooling/remote.js';
import { REUSE_CAPSULE } from '../../../src/io/runtime.js';
import { forgetRuntimeHeld } from '../../../src/io/runtime.js';
import { recordRuntimeHeld } from '../../../src/io/runtime.js';
import { runtimeHeld } from '../../../src/io/runtime.js';

/** OpenSSH resets a session whose exec request exceeds its 256 KiB packet bound. */
const SSH_PACKET_LIMIT = 256 * 1024;

/** A runtime whose compressed capsule alone exceeds the SSH bound, plus a worker that echoes the rest of stdin. */
function largeTooling() {
  const entry = 'apps/runner/src/io/scripts/worker.js';
  const worker = "process.stdin.pipe(process.stdout);\n";
  // Random base64 barely compresses, so the gzip+base64 payload stays well above 256 KiB.
  const runtimeFiles = { 'src/bulk.js': `export const bulk = ${JSON.stringify(randomBytes(300 * 1024).toString('base64'))};\n` };
  const files = Object.fromEntries(Object.entries({ ...runtimeFiles, [entry]: worker }).sort(([a], [b]) => a.localeCompare(b)));
  const sha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { entry, worker, tooling: { sha256 }, runtime: { entry, files: runtimeFiles } };
}

test('runners.remote.the-worker-command-stays-far-below: clause 1: the worker command stays far below the SSH packet bound however large the capsule is [C7]', () => {
  const { worker, tooling, runtime } = largeTooling();
  const { command, input } = remoteWorkerLaunch({ host: 'runner', node: process.execPath }, worker, tooling, runtime, '', null);
  assert.ok(input.length > SSH_PACKET_LIMIT, 'the fixture capsule must be larger than the SSH bound');
  assert.ok(Buffer.byteLength(command) < 16 * 1024, `command is ${Buffer.byteLength(command)} bytes`);
  assert.ok(!command.includes(input.subarray(20, 80).toString('ascii')), 'the capsule payload never appears in the command');
});

/** Run work with a private runner root, removed afterwards. */
function withRoot(work) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-capsule-'));
  try { return work(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('runners.remote.a-capsule-larger-than-the-ssh: clause 2: a capsule larger than the SSH bound installs from stdin and the worker reads exactly the bytes after it [C7]', () => withRoot(root => {
  {
    const { entry, worker, tooling, runtime } = largeTooling();
    const { command, input } = remoteWorkerLaunch({ host: 'runner', node: process.execPath, root }, worker, tooling, runtime, '', null);
    const frame = Buffer.from('12\n{"job":"x"}');
    const result = spawnSync('/bin/sh', ['-c', command], { input: Buffer.concat([input, frame]), maxBuffer: 1024 ** 2 });
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(result.stdout.toString(), frame.toString());
    assert.equal(readFileSync(join(root, 'runtime', tooling.sha256, entry), 'utf8'), worker);
  }
}));

test('runners.remote.the-file-passes-including-a-truncated: clause 3: the file passes, including a truncated capsule fails before the worker starts [C7]', () => withRoot(root => {
  {
    const { worker, tooling, runtime } = largeTooling();
    const { command, input } = remoteWorkerLaunch({ host: 'runner', node: process.execPath, root }, worker, tooling, runtime, '', null);
    const result = spawnSync('/bin/sh', ['-c', command], { input: input.subarray(0, input.length - 10), maxBuffer: 1024 ** 2 });
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /runner capsule ended early/u);
    assert.equal(result.stdout.length, 0);
  }
}));

/** Launch with an optional reuse capsule and feed it one job frame; the result of the remote shell. */
function launch(root, tooling, runtime, worker, reuse) {
  const { command, input } = remoteWorkerLaunch({ host: 'runner', node: process.execPath, root }, worker, tooling, runtime, '', null, { reuse });
  return { input, result: spawnSync('/bin/sh', ['-c', command], { input: Buffer.concat([input, Buffer.from('12\n{"job":"x"}')]), maxBuffer: 1024 ** 2 }) };
}

test('runners.remote.n4140-clause-1-a-runner-holding: #4140 clause 1: a runner holding the runtime by digest gets a reuse capsule and starts from its installed copy [C7]', () => withRoot(root => {
  const { worker, tooling, runtime } = largeTooling();
  assert.equal(launch(root, tooling, runtime, worker, false).result.status, 0, 'the first launch installs the runtime');
  const { input, result } = launch(root, tooling, runtime, worker, true);
  assert.equal(input.toString('ascii'), `${REUSE_CAPSULE.length}\n${REUSE_CAPSULE}`, 'no runtime bytes cross the wire');
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout.toString(), '12\n{"job":"x"}', 'the worker reads exactly the frame after the reuse capsule');
}));

test('runners.remote.n4140-clause-1-a-reuse-launch: #4140 clause 1: a reuse launch refuses a runtime that is missing or changed, so the next launch sends it whole [C7]', () => withRoot(root => {
  const { entry, worker, tooling, runtime } = largeTooling();
  assert.match(String(launch(root, tooling, runtime, worker, true).result.stderr), /PULLBOARD_RUNNER_RUNTIME_MISSING/u, 'nothing installed yet');
  launch(root, tooling, runtime, worker, false);
  writeFileSync(join(root, 'runtime', tooling.sha256, entry), 'process.exit(0);\n');
  const { result } = launch(root, tooling, runtime, worker, true);
  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr), /PULLBOARD_RUNNER_RUNTIME_MISSING/u);
}));

test('runners.remote.n4140-clause-1-the-transfer-bound: #4140 clause 1: the transfer bound applies to the gzipped capsule, not the raw bundle [C7]', () => {
  const entry = 'apps/runner/src/io/scripts/worker.js', worker = 'process.stdin.pipe(process.stdout);\n';
  /** A tooling of one runtime file and the worker, named by its digest. */
  const tooling = body => {
    const runtimeFiles = { 'src/bulk.js': body };
    const files = Object.fromEntries(Object.entries({ ...runtimeFiles, [entry]: worker }).sort(([a], [b]) => a.localeCompare(b)));
    return { tooling: { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') }, runtime: { entry, files: runtimeFiles } };
  };
  const roomy = tooling(`export const text = ${JSON.stringify('the same worker line\n'.repeat(100_000))};\n`);
  assert.ok(Buffer.byteLength(JSON.stringify(roomy.runtime.files)) > 1_048_576, 'the raw bundle is past the old 1 MiB raw check');
  assert.doesNotThrow(() => remoteWorkerLaunch({ host: 'runner', node: process.execPath }, worker, roomy.tooling, roomy.runtime, '', null));
  const dense = tooling(`export const bulk = ${JSON.stringify(randomBytes(Math.ceil(CAPSULE_STDIN_LIMIT * 0.8)).toString('base64'))};\n`);
  assert.throws(() => remoteWorkerLaunch({ host: 'runner', node: process.execPath }, worker, dense.tooling, dense.runtime, '', null), { code: 'RUNNER_REQUEST_LIMIT' }, 'a capsule that would cross the wire past its bound refuses');
});

test('runners.remote.n4140-clause-1-ready-records-that: #4140 clause 1: READY records that a runner holds a runtime, and a failed reuse forgets it [C7]', () => withRoot(root => {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = root;
  try {
    const digest = 'a'.repeat(64);
    assert.equal(runtimeHeld('runner-1', digest), false);
    recordRuntimeHeld('runner-1', digest);
    assert.equal(runtimeHeld('runner-1', digest), true);
    assert.equal(runtimeHeld('runner-2', digest), false, 'another runner holds nothing');
    assert.equal(runtimeHeld('runner-1', digest, Date.now() + 25 * 60 * 60_000), false, 'a day-old READY vouches for nothing');
    forgetRuntimeHeld('runner-1', digest);
    assert.equal(runtimeHeld('runner-1', digest), false);
  } finally { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; }
}));
