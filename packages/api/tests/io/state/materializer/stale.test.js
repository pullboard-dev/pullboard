/** @pullboard-test-input source-cell api */
/** A restarted server serves the snapshot saved by other code to its first read, so the board's first load never waits out a full rebuild [C7,#8471]. */
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
import { serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';

const WORKER = fileURLToPath(new URL('../../../../src/io/state/materializer/worker.js', import.meta.url));
const ENV_FRONT_DOOR = fileURLToPath(new URL('../../../../../env/index.js', import.meta.url));
const ENV_ADAPTER = fileURLToPath(new URL('../../../../../env/src/io/env.js', import.meta.url));
const BOARD = { id: 'b', root: 'r' };
const FIELDS = ['summary', 'compact', 'open', 'finished', 'search', 'shouts', 'deltas', 'reportValidator'];

/** A copy of the real worker in a small code tree whose board modules are stubs and whose snapshot store holds the one saved snapshot given. */
function codeTree(t, snapshot) {
  const { root } = privateFixtureFiles('pullboard-stale-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
  write('packages/api/src/io/state/materializer/worker.js', readFileSync(WORKER));
  write('packages/env/index.js', readFileSync(ENV_FRONT_DOOR));
  write('packages/env/src/io/env.js', readFileSync(ENV_ADAPTER));
  write('packages/api/src/io/main.js', `export function createStateSnapshots() {
  return { formats: 'f', snapshotPlace: () => ({ cacheId: 'c', folder: 'f' }), carry: () => ({}), restore() { globalThis.restoredCarry = true; }, materialize: () => ({ sequence: 1 }) };
}\n`);
  write('ports.js', `import { readFileSync } from 'node:fs';
export async function boardStatePorts() {
  const bytes = () => readFileSync(process.env.SNAPSHOT_IN);
  return { snapshotStore: { load: () => bytes(), saved: () => [bytes()], save() {} } };
}\n`);
  writeFileSync(join(root, 'snapshot.bin'), serialize(snapshot));
  return root;
}

/** Start the copied worker over the snapshot, close it, and return every record it posted while starting. */
async function startedRecords(root) {
  const worker = new Worker(join(root, 'packages/api/src/io/state/materializer/worker.js'), {
    workerData: { portsModule: pathToFileURL(join(root, 'ports.js')).href, projects: [{ root: BOARD.root }] }, execArgv: [], env: { ...process.env, SNAPSHOT_IN: join(root, 'snapshot.bin') } });
  const records = [];
  worker.on('message', message => { if (message.type === 'record') records.push(message); });
  await new Promise((done, fail) => { worker.on('error', fail); worker.on('exit', done); worker.postMessage({ type: 'close' }); });
  return records;
}

const record = () => ({ sequence: 9, revision: 'old', current: true, ...Object.fromEntries(FIELDS.map(field => [field, { json: ['x'] }])) });
const saved = (more = {}) => ({ version: 1, key: 'c\0old-code', formats: 'f', board: BOARD, sequence: 9, carry: {}, record: record(), ...more });

test('api.state-materializer-stale.snapshot-saved-other-code-served: clause 1: a snapshot saved by other code is served as a stale record with no revision, so no read takes it as current [C7,#8471]', async t => {
  const [served, ...rest] = await startedRecords(codeTree(t, saved()));
  assert.equal(rest.length, 0);
  assert.equal(served.restored, true);
  assert.equal(served.record.sequence, 9, 'the saved build answers the first read');
  assert.equal(served.record.revision, null, 'a read of the unchanged board still waits for the build by this code');
  assert.equal(served.record.current, false);
});

test('api.state-materializer-stale.snapshot-saved-other-formats-missing: clause 2: a snapshot saved for other formats, or missing a field a read joins, is never served [C7,#8471]', async t => {
  assert.deepEqual(await startedRecords(codeTree(t, saved({ formats: 'older' }))), [], 'another schema or event log format');
  assert.deepEqual(await startedRecords(codeTree(t, saved({ record: { ...record(), open: undefined } }))), [], 'a record without the open variant');
  assert.deepEqual(await startedRecords(codeTree(t, saved({ key: 'other-board\0old-code' }))), [], 'another board');
  assert.deepEqual(await startedRecords(codeTree(t, saved({ formats: undefined }))), [], 'a snapshot saved before formats were kept');
});
