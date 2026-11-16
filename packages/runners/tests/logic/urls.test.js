/** The work spec names the installed runtime by digest, so worker code past 1 MiB still fits a runner request [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { remoteWorkerLaunch } from '../../src/io/tooling/remote.js';
import { runtimeReference } from '../../src/io/request.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../gate/tests/fixtures/child.js';

const ENTRY = 'apps/runner/src/io/scripts/worker.js';
const SPEC_FRAME_LIMIT = 1024 ** 2;

/** A worker that reads its spec with the real reader and prints the runtime it accepted, or the reader's refusal. */
function echoWorker() {
  const reader = new URL('../../../../apps/runner/src/io/worker/spec.js', import.meta.url).href;
  const state = new URL('../../../../apps/runner/src/io/worker/context.js', import.meta.url).href;
  return `import { readSpec } from ${JSON.stringify(reader)};
import { createWorkerState } from ${JSON.stringify(state)};
try {
  const spec = await readSpec(createWorkerState(import.meta.url));
  console.log(JSON.stringify({ ok: true, sha256: spec.runtime.sha256, files: Object.keys(spec.runtime.files).length, bulk: spec.runtime.files['src/bulk.js'].length }));
} catch (error) { console.log(JSON.stringify({ ok: false, message: error.message })); }
process.exit(0);
`;
}

/** Tooling whose runtime holds `bytes` of barely compressible source, with the digests the controller computes. */
function tooling(bytes) {
  const runtimeFiles = { 'package.json': '{"name":"pullboard","type":"module"}\n',
    'src/bulk.js': `export const bulk = ${JSON.stringify(randomBytes(Math.ceil(bytes * 3 / 4)).toString('base64'))};\n` };
  const worker = echoWorker();
  const files = Object.fromEntries(Object.entries({ ...runtimeFiles, [ENTRY]: worker }).sort(([a], [b]) => a.localeCompare(b)));
  const toolingSha = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const runtime = { entry: ENTRY, files: runtimeFiles, sha256: createHash('sha256').update(JSON.stringify(runtimeFiles)).digest('hex') };
  return { worker, runtime, tooling: { kind: 'git-checkout', name: 'pullboard', version: '0.0.0', sha256: toolingSha } };
}

/** The smallest valid work spec around a runtime reference, framed as the controller frames it. */
function frame(tools) {
  const spec = { version: 1, id: 'job-1', repoId: 'a'.repeat(64), commit: 'b'.repeat(40), tree: 'c'.repeat(40), command: 'true',
    pipefail: false, slots: 1, browser: 0, browserRequired: false, tags: [], runtime: runtimeReference(tools.runtime), tooling: tools.tooling };
  const body = Buffer.from(JSON.stringify(spec));
  return Buffer.concat([Buffer.from(`${body.length}\n`), body]);
}

/** Run the installed worker directly with one framed spec on stdin and parse its one-line answer. */
function runInstalled(fixture, tools) {
  const entry = join(fixture.root, 'runtime', tools.tooling.sha256, ENTRY);
  const result = runFixtureChild(process.execPath, [entry], { input: frame(tools), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('clause 1: a runtime past 2 MiB is named in a spec far below the 1 MiB frame, with no source inline [C7]', () => {
  const tools = tooling(2 * 1024 ** 2);
  const reference = runtimeReference(tools.runtime);
  assert.ok(Buffer.byteLength(JSON.stringify(tools.runtime)) > 2 * SPEC_FRAME_LIMIT, 'the fixture runtime must be past the frame');
  assert.ok(frame(tools).length < 64 * 1024, `spec frame is ${frame(tools).length} bytes`);
  assert.deepEqual(reference, { entry: ENTRY, sha256: tools.runtime.sha256, names: ['package.json', 'src/bulk.js'] });
  assert.equal(JSON.stringify(reference).includes(tools.runtime.files['src/bulk.js'].slice(30, 90)), false);
});

test('clauses 2 and 3: a capsule past 1 MiB installs, and the worker rebuilds and checks the named runtime from it [C7]', t => {
  const fixture = privateFixtureFiles('pullboard-runtime-ref-');
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const tools = tooling(1536 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(tools.runtime.files)) > SPEC_FRAME_LIMIT, 'the capsule must unpack past 1 MiB');
  const { command, input } = remoteWorkerLaunch({ host: 'runner', node: process.execPath, root: fixture.root }, tools.worker, tools.tooling, tools.runtime, '', null);
  const launched = runFixtureChild('/bin/sh', ['-c', command], { input: Buffer.concat([input, frame(tools)]), encoding: 'utf8', maxBuffer: 1024 ** 2 });
  assert.equal(launched.status, 0, launched.stderr);
  const accepted = JSON.parse(launched.stdout);
  assert.deepEqual(accepted, { ok: true, sha256: tools.runtime.sha256, files: 2, bulk: tools.runtime.files['src/bulk.js'].length });
  assert.deepEqual(runInstalled(fixture, tools), accepted, 'a second job reuses the installed runtime');
  const installed = join(fixture.root, 'runtime', tools.tooling.sha256);
  writeFileSync(join(installed, 'src/bulk.js'), 'export const bulk = "changed";\n');
  assert.deepEqual(runInstalled(fixture, tools), { ok: false, message: 'invalid trusted runtime' });
  unlinkSync(join(installed, 'src/bulk.js'));
  assert.deepEqual(runInstalled(fixture, tools), { ok: false, message: 'trusted runtime cache does not match the request' });
});
