/** @pullboard-test-input packages/api/src/io/state/materializer/worker.js */
/** The state snapshot's code stamp covers the release's package.json, so a CLI copy with a new version rebuilds [A2,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { deserialize } from 'node:v8';
import { Worker } from 'node:worker_threads';

const WORKER = fileURLToPath(new URL('../../../../src/io/state/materializer/worker.js', import.meta.url));
const ENV_FRONT_DOOR = fileURLToPath(new URL('../../../../../env/index.js', import.meta.url));
const ENV_ADAPTER = fileURLToPath(new URL('../../../../../env/src/io/env.js', import.meta.url));

/** A copy of the real worker in a small code tree whose board modules are stubs, so the key it saves can be read back. */
function codeTree(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-stamp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = { root, write(file, content) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  } };
  tree.write('packages/api/src/io/state/materializer/worker.js', readFileSync(WORKER));
  tree.write('packages/env/index.js', readFileSync(ENV_FRONT_DOOR));
  tree.write('packages/env/src/io/env.js', readFileSync(ENV_ADAPTER));
  tree.write('packages/api/src/io/main.js', `export function createStateSnapshots() {
  return { formats: 'f', snapshotPlace: () => ({ cacheId: 'c', folder: 'f' }), carry: () => ({}), restore() {}, materialize: () => ({ sequence: 1 }) };
}\n`);
  tree.write('ports.js', `import { writeFileSync } from 'node:fs';
export async function boardStatePorts() {
  return { snapshotStore: { load: () => null, saved: () => [], save: (_folder, _id, bytes) => writeFileSync(process.env.STAMP_OUT, bytes) } };
}\n`);
  return tree;
}

/** Run the copied worker for one build, then a close, and return the key its saved snapshot carries. */
async function savedKey(tree) {
  const out = join(tree.root, 'snapshot.bin');
  const worker = new Worker(join(tree.root, 'packages/api/src/io/state/materializer/worker.js'), {
    workerData: { portsModule: pathToFileURL(join(tree.root, 'ports.js')).href, projects: [] }, execArgv: [], env: { ...process.env, STAMP_OUT: out } });
  await new Promise((done, fail) => {
    worker.on('error', fail);
    worker.on('exit', done);
    worker.postMessage({ type: 'build', id: 1, key: 'b\0r', board: { id: 'b', root: 'r' }, held: [], full: false });
    worker.postMessage({ type: 'close' });
  });
  return deserialize(readFileSync(out)).key;
}

test('api.state-materializer-stamp.saved-snapshot-key-changes-when: clause 1: the saved snapshot key changes when the root package.json changes [A2,C7]', async (t) => {
  const tree = codeTree(t);
  tree.write('package.json', '{"version":"0.9.4"}\n');
  const before = await savedKey(tree);
  assert.equal(await savedKey(tree), before, 'unchanged code keeps its key');
  tree.write('package.json', '{"version":"0.9.5"}\n');
  assert.notEqual(await savedKey(tree), before);
});
