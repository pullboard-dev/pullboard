/** @pullboard-test-input source-cell api */
/** With api.codeStampCache on, a state worker restart over an unchanged code tree reads its saved code stamp without walking the source folders [A2,C7,#9679]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { deserialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { serialize } from 'node:v8';

const WORKER = fileURLToPath(new URL('../../../../src/io/state/materializer/worker.js', import.meta.url));
const ENV_FRONT_DOOR = fileURLToPath(new URL('../../../../../env/index.js', import.meta.url));
const ENV_ADAPTER = fileURLToPath(new URL('../../../../../env/src/io/env.js', import.meta.url));

/** A copy of the real worker in a small code tree whose board modules are stubs and whose snapshot store keeps each key in a file of its own. */
function codeTree(t) {
  const { root } = privateFixtureFiles('pullboard-code-stamp-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cacheDir = join(root, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const tree = { root: join(root, 'code'), cacheDir, write(file, content) {
    mkdirSync(dirname(join(tree.root, file)), { recursive: true });
    writeFileSync(join(tree.root, file), content);
  } };
  tree.write('packages/api/src/io/state/materializer/worker.js', readFileSync(WORKER));
  tree.write('packages/env/index.js', readFileSync(ENV_FRONT_DOOR));
  tree.write('packages/env/src/io/env.js', readFileSync(ENV_ADAPTER));
  tree.write('packages/api/src/io/main.js', `export function createStateSnapshots() {
  return { formats: 'f', snapshotPlace: () => ({ cacheId: 'c', folder: 'f' }), carry: () => ({}), restore() {}, materialize: () => ({ sequence: 1 }) };
}\n`);
  tree.write('ports.js', `import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const file = (id) => join(process.env.STAMP_CACHE, encodeURIComponent(id));
export async function boardStatePorts() {
  return { snapshotStore: {
    load: (_folder, id) => { try { return readFileSync(file(id)); } catch { return null; } },
    saved: () => [],
    save: (_folder, id, bytes) => writeFileSync(file(id), bytes) } };
}\n`);
  tree.write('package.json', '{"version":"0.9.5"}\n');
  return tree;
}

/** Run the copied worker for one build, then a close, and return the code stamp its saved snapshot key carries. */
async function savedStamp(tree, { cache }) {
  const worker = new Worker(join(tree.root, 'packages/api/src/io/state/materializer/worker.js'), {
    workerData: { portsModule: pathToFileURL(join(tree.root, 'ports.js')).href, projects: [{ root: tree.root }], codeStampCache: cache },
    execArgv: [], env: { ...process.env, STAMP_CACHE: tree.cacheDir, PULLBOARD_STATE_CACHE_DIR: 'state-cache' } });
  await new Promise((done, fail) => {
    worker.on('error', fail);
    worker.on('exit', done);
    worker.postMessage({ type: 'build', id: 1, key: 'b\0r', board: { id: 'b', root: 'r' }, held: [], full: false });
    worker.postMessage({ type: 'close' });
  });
  return deserialize(readFileSync(join(tree.cacheDir, 'c'))).key.split('\0')[1];
}

/** The cached stamp record the worker saved, as its file and decoded value; null when it saved none. */
function cacheRecord(tree) {
  const name = readdirSync(tree.cacheDir).find((file) => file.startsWith('code-stamp'));
  if (!name) return null;
  const file = join(tree.cacheDir, name);
  return { file, record: deserialize(readFileSync(file)) };
}

test('api.state-materializer-code-stamp.cache-restart-over-unchanged-tree: clause 1: with the cache on, a restart over an unchanged tree reads the cached code stamp without walking the source folders [A2,C7,#9679]', async (t) => {
  const tree = codeTree(t);
  const walked = await savedStamp(tree, { cache: false });
  assert.equal(cacheRecord(tree), null, 'with the cache off no stamp is saved');
  assert.equal(await savedStamp(tree, { cache: true }), walked, 'the first start walks and stamps exactly as before');
  const { file, record } = cacheRecord(tree);
  assert.ok(record.files.length > 0, 'the cache records the stamped files');
  // Plant a stamp no walk could produce: the restart can only return it by reading the cache.
  writeFileSync(file, serialize({ ...record, stamp: 'cached-stamp-no-walk-makes' }));
  assert.equal(await savedStamp(tree, { cache: true }), 'cached-stamp-no-walk-makes', 'an unchanged tree reads the saved stamp');
  assert.equal(await savedStamp(tree, { cache: false }), walked, 'with the cache off the planted stamp is never read');
});

test('api.state-materializer-code-stamp.cache-edited-added-removed-source: clause 2: with the cache on, an edited, added or removed source file changes the stamp [A2,C7,#9679]', async (t) => {
  const tree = codeTree(t);
  tree.write('packages/api/src/io/thing.js', 'export const a = 1;\n');
  await savedStamp(tree, { cache: true });
  const plant = () => { const { file, record } = cacheRecord(tree); writeFileSync(file, serialize({ ...record, stamp: 'planted' })); };
  plant();
  assert.equal(await savedStamp(tree, { cache: true }), 'planted', 'the unchanged tree reads the cache');
  tree.write('packages/api/src/io/thing.js', 'export const a = 22222;\n');
  const edited = await savedStamp(tree, { cache: true });
  assert.notEqual(edited, 'planted', 'an edited file changes the stamp');
  assert.equal(edited, await savedStamp(tree, { cache: false }), 'the changed stamp is the one a full walk gives');
  plant();
  tree.write('packages/api/src/io/other.js', 'export const b = 1;\n');
  const added = await savedStamp(tree, { cache: true });
  assert.notEqual(added, 'planted', 'an added file changes the stamp');
  assert.equal(added, await savedStamp(tree, { cache: false }));
  plant();
  rmSync(join(tree.root, 'packages/api/src/io/other.js'));
  const removed = await savedStamp(tree, { cache: true });
  assert.notEqual(removed, 'planted', 'a removed file changes the stamp');
  assert.equal(removed, await savedStamp(tree, { cache: false }));
  plant();
  tree.write('package.json', '{"version":"0.9.6"}\n');
  assert.notEqual(await savedStamp(tree, { cache: true }), 'planted', 'a new release version changes the stamp');
});
