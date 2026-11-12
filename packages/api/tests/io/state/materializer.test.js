/** @pullboard-test-input source-tree */
/** Closing a materializer whose worker is busy ends the worker within the grace period, so the process exits promptly [A2,C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

const STATE = fileURLToPath(new URL('../../../src/io/state/', import.meta.url));

/** A copy of the materializer and its worker in a small tree whose builds block the worker for `buildMs` each. */
function busyTree(t, buildMs) {
  const { root, write } = privateFixtureFiles('pullboard-close-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write('packages/api/src/io/state/materializer.js', readFileSync(join(STATE, 'materializer.js')));
  write('packages/api/src/io/state/materializer/worker.js', readFileSync(join(STATE, 'materializer/worker.js')));
  write('packages/api/src/io/main.js', `export function createStateSnapshots() {
  return { formats: 'f', snapshotPlace: () => ({ cacheId: 'c', folder: 'f' }), carry: () => ({}), restore() {},
    materialize() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${buildMs}); return { sequence: 1 }; } };
}\n`);
  write('ports.js', `export async function boardStatePorts() { return {}; }\n`);
  write('run.js', `import { startStateMaterializer } from './packages/api/src/io/state/materializer.js';
const materializer = startStateMaterializer({ portsModule: ${JSON.stringify(pathToFileURL(join(root, 'ports.js')).href)}, projects: () => [], isMain: true,
  openRevision: () => ({ revision: () => 'r1' }), Refused: class extends Error {} });
for (const id of ['a', 'b', 'c']) materializer.search({ id, root: '/' + id }, '').catch(() => {});
setTimeout(() => { process.stdout.write('closing\\n'); materializer.close(); }, 500);
`);
  return join(root, 'run.js');
}

/** Run the script and return how long after it printed "closing" the process exited. */
function exitAfterClose(script) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let closedAt = 0;
    child.stdout.on('data', () => { closedAt ||= Date.now(); });
    child.on('error', fail);
    child.on('exit', () => done(Date.now() - closedAt));
  });
}

test('clause 1: a materializer closed with queued builds ends its worker and exits within 5 s [A2,C7]', async (t) => {
  // Three builds of 6 s each queue behind one another: without the grace period the close waits about 18 s.
  const took = await exitAfterClose(busyTree(t, 6_000));
  assert.ok(took < 5_000, `the process took ${took} ms to exit after close`);
});

test('clause 1: a materializer with an idle worker exits at once on close [A2,C7]', async (t) => {
  const took = await exitAfterClose(busyTree(t, 0));
  assert.ok(took < 1_500, `the process took ${took} ms to exit after close`);
});
