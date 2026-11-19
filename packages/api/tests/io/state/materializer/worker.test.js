/** @pullboard-test-input source-cell api */
/** A build made while the view still reads its row ages is never served as current, so the next read picks up the landed ages [A2,N26,#10869]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';

const WORKER = fileURLToPath(new URL('../../../../src/io/state/materializer/worker.js', import.meta.url));
const BOARD = { id: 'b', root: 'r' };

/** A copy of the real worker in a small code tree whose snapshots answer each build with the next given build, and no snapshot store. */
function codeTree(t, builds) {
  const { root } = privateFixtureFiles('pullboard-ages-pending-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
  write('packages/api/src/io/state/materializer/worker.js', readFileSync(WORKER));
  write('packages/api/src/io/main.js', `const builds = ${JSON.stringify(builds)};
export function createStateSnapshots() {
  return { formats: 'f', snapshotPlace: () => ({ cacheId: 'c', folder: 'f' }), carry: () => null, restore() {}, materialize: () => builds.shift() };
}\n`);
  write('ports.js', 'export async function boardStatePorts() { return {}; }\n');
  return root;
}

/** Ask the copied worker for one build per given revision and return each record it posted. */
async function builtRecords(root, revisions) {
  const worker = new Worker(join(root, 'packages/api/src/io/state/materializer/worker.js'), {
    workerData: { portsModule: pathToFileURL(join(root, 'ports.js')).href, projects: [{ root: BOARD.root }] }, execArgv: [] });
  const records = [];
  const done = new Promise((ok, fail) => {
    worker.on('error', fail);
    worker.on('message', (message) => {
      if (message.type === 'error') fail(new Error(JSON.stringify(message.error)));
      if (message.type !== 'record' || message.restored) return;
      records.push(message.record);
      if (records.length === revisions.length) ok();
    });
  });
  revisions.forEach((revision, index) => worker.postMessage({ type: 'build', id: index + 1, key: 'k', board: BOARD, held: [], full: false, revision }));
  await done;
  await worker.terminate();
  return records;
}

test('api.state-materializer-worker.build-row-ages-still-read: clause 1: a build whose row ages are still being read posts no revision, so the next read builds again [A2,N26,#10869]', async t => {
  const [pending, landed] = await builtRecords(codeTree(t, [
    { sequence: 1, current: false, rowAgesPending: true },
    { sequence: 2, current: true, rowAgesPending: false },
  ]), ['rev-1', 'rev-1']);
  assert.equal(pending.revision, null, 'a read of the unchanged board never matches the build made before its row ages landed');
  assert.equal(pending.current, false);
  assert.equal(landed.revision, 'rev-1', 'the build after the ages land keeps the revision its request read, so later reads reuse it');
  assert.equal(landed.current, true);
});
