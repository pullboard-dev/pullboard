/** @pullboard-test-input source-cell api */
/**
 * A big board's state loads in seconds: a read of an unchanged board is served from the record kept for it with no
 * build, a first page load may take the kept record while the next build runs, and the reply is gzip-encoded when the
 * request accepts gzip [A2,C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createApiHandler } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

const MATERIALIZER = fileURLToPath(new URL('../../../src/io/state/materializer.js', import.meta.url));
const ENV_FRONT_DOOR = fileURLToPath(new URL('../../../../env/index.js', import.meta.url));
const ENV_ADAPTER = fileURLToPath(new URL('../../../../env/src/io/env.js', import.meta.url));
const STATE_DIR = 'packages/api/src/io/state';
/** How long the stub worker takes over each build, standing in for a big board's build. */
const BUILD_MS = 400;

/**
 * The real materializer beside a stub worker that answers each build after BUILD_MS with a record at the revision it was
 * asked for and the build's number as its sequence. Why a copy: the materializer starts the worker beside itself.
 */
async function stubbedMaterializer(t, { restored = false } = {}) {
  const files = privateFixtureFiles('pullboard-kept-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  files.write(`${STATE_DIR}/materializer.js`, readFileSync(MATERIALIZER));
  files.write('packages/env/index.js', readFileSync(ENV_FRONT_DOOR));
  files.write('packages/env/src/io/env.js', readFileSync(ENV_ADAPTER));
  files.write(`${STATE_DIR}/materializer/worker.js`, `import { parentPort } from 'node:worker_threads';
let built = 0;
let restored = ${restored};
parentPort.on('message', (message) => {
  if (message.type === 'close') return process.exit(0);
  if (restored) {
    restored = false;
    const parts = ['{"sequence":0,"observedAt":"' + new Date().toISOString() + '","unseen":', '}'];
    const variant = { json: parts, validator: parts };
    parentPort.postMessage({ type: 'record', key: message.key, board: message.board, restored: true, record: { revision: 'saved', sequence: 0, observedAt: Date.now(),
      eventLogVersion: 1, summary: variant, compact: variant, full: null, deltas: {}, shouts: [], search: [], reportValidator: null } });
  }
  built += 1;
  const sequence = built;
  parentPort.postMessage({ type: 'build', board: message.board, full: false });
  setTimeout(() => {
    const observedAt = Date.now();
    const at = new Date(observedAt).toISOString();
    const parts = ['{"sequence":' + sequence + ',"observedAt":"' + at + '","unseen":', '}'];
    const variant = { json: parts, validator: parts };
    parentPort.postMessage({ type: 'record', id: message.id, key: message.key, record: { revision: message.revision, sequence, observedAt,
      eventLogVersion: 1, summary: variant, compact: variant, full: null, deltas: {}, shouts: [], search: [], reportValidator: null } });
  }, ${BUILD_MS});
});
`);
  return (await import(pathToFileURL(join(files.root, STATE_DIR, 'materializer.js')).href)).startStateMaterializer;
}

/** A materializer over one stub board whose revision the test sets, counting the builds it starts. */
async function stubBoard(t, options = {}) {
  const startStateMaterializer = await stubbedMaterializer(t, options);
  const board = { id: 'kept', root: '/kept' };
  const builds = [];
  const heard = new Set();
  const watched = { revision: 'r1' };
  const materializer = startStateMaterializer({ portsModule: 'data:text/javascript,', projects: () => [], isMain: true,
    openRevision: () => ({ revision: () => watched.revision }), Refused: class extends Error {},
    onStateBuild: (build) => { builds.push(build); for (const check of [...heard]) check(); } });
  t.after(() => materializer.close());
  /** One timed state read and the sequence it serves. */
  const read = async (options = {}) => {
    const started = performance.now();
    const sent = await materializer.stateJson(board, null, options);
    return { sequence: JSON.parse(sent.json).sequence, ms: performance.now() - started };
  };
  /** Resolve once the worker has announced `count` builds; the worker's own notices drive it. */
  const built = (count) => new Promise((done) => { const check = () => { if (builds.length >= count) { heard.delete(check); done(); } }; heard.add(check); check(); });
  /**
   * Change the board and read it plainly: that read waits on exactly one new build, and the worker announces builds in
   * order, so the count after it shows whether any read before it started a build of its own.
   */
  const probe = async (revision) => { watched.revision = revision; const before = builds.length; const sent = await read(); return { ...sent, started: builds.length - before - 1 }; };
  return { materializer, board, builds, watched, read, built, probe };
}

test('api.state-kept.second-state-read-board-change: clause 1: a second state read with no board change is served from the kept record without a build [A2,C7]', async (t) => {
  const { builds, read, probe } = await stubBoard(t);
  const first = await read();
  assert.equal(builds.length, 1, 'the first read waits on one build');
  const second = await read();
  assert.equal(second.sequence, first.sequence, 'the second read serves the kept record');
  assert.ok(second.ms < BUILD_MS / 2, `the second read took ${second.ms.toFixed(1)} ms, not a build's ${BUILD_MS} ms`);
  const after = await probe('r2');
  assert.equal(after.started, 0, 'the second read started no build');
  assert.equal(after.sequence, first.sequence + 1, 'the next build is the first after the first read');
});

test('api.state-kept.kept-read-after-change-serves: clause 3: a kept read after a change serves the kept record at once and starts the build, and a plain read still waits for the write [A2,C7]', async (t) => {
  const { watched, read, built, probe } = await stubBoard(t);
  const first = await read();
  watched.revision = 'r2';
  const kept = await read({ kept: true });
  assert.equal(kept.sequence, first.sequence, 'the kept read serves the record from before the change');
  assert.ok(kept.ms < BUILD_MS / 2, `the kept read took ${kept.ms.toFixed(1)} ms, not a build's ${BUILD_MS} ms`);
  await built(2);
  const plain = await read();
  assert.ok(plain.sequence > first.sequence, 'a read without kept never serves state from before the change it follows');
  const again = await read({ kept: true });
  assert.equal(again.sequence, plain.sequence, 'a kept read of an unchanged board serves the newest record');
  assert.equal((await probe('r3')).started, 0, 'that read started no build');
});

/** Serve a stub state of `size` characters through the real API handler, tagging it as the local server does. */
async function stateServer(t, size) {
  const state = JSON.stringify({ sequence: 7, observedAt: '2026-11-12T00:00:00.000Z', items: 'x'.repeat(size) });
  const handler = createApiHandler({ refusalDocument: (error) => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } }),
    authenticate: () => ({ local: true }), board: (id) => ({ id }), stateJson: () => ({ json: state, validator: state }), eventLogVersion: () => 1,
  }, { tagState: true });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  return { port: server.address().port, state };
}

/** One raw state read: its status, headers and undecoded body bytes. */
function rawRead(port, headers) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/v1/boards/fixture/state?items=compact', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', fail);
    req.end();
  });
}

test('api.state-kept.state-reply-gzip-encoded-when: clause 2: the state reply is gzip-encoded when the request accepts gzip, with the same validator [A2,C7]', async (t) => {
  const { port, state } = await stateServer(t, 200_000);
  const plain = await rawRead(port, {});
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined, 'a request that names no encoding gets plain JSON');
  assert.equal(JSON.parse(plain.body.toString()).state.items, JSON.parse(state).items);
  const zipped = await rawRead(port, { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.match(String(zipped.headers.vary), /accept-encoding/iu, 'caches keep the encodings apart');
  assert.ok(zipped.body.length < plain.body.length / 10, `${zipped.body.length} bytes on the wire against ${plain.body.length}`);
  assert.equal(gunzipSync(zipped.body).toString(), plain.body.toString(), 'the gzip body decodes to the plain reply');
  assert.equal(zipped.headers.etag, plain.headers.etag, 'the validator names the board state, not its encoding');
  const unchanged = await rawRead(port, { 'accept-encoding': 'gzip', 'if-none-match': zipped.headers.etag });
  assert.equal(unchanged.status, 304, 'a held validator still answers Not Modified');
  assert.equal(unchanged.body.length, 0);
  const refused = await rawRead(port, { 'accept-encoding': 'gzip;q=0, identity' });
  assert.equal(refused.headers['content-encoding'], undefined, 'gzip;q=0 refuses gzip');
});

/** One timed delta read from `since`, with the sequence it answers at. */
async function timedDelta(materializer, board, since) {
  const started = performance.now();
  const answer = await materializer.delta(board, null, { since }, (error) => ({ error: { code: String(error.message) } }));
  return { sequence: answer.sequence, ms: performance.now() - started };
}

test('api.state-kept.delta-read-after-change-answers: #6850 clause 1: a delta read after a change answers at once from the last build and starts the build that catches up [A2,C7]', async (t) => {
  const { materializer, board, watched, read } = await stubBoard(t);
  const first = await read();
  watched.revision = 'r2';
  const delta = await timedDelta(materializer, board, first.sequence);
  assert.equal(delta.sequence, first.sequence, 'the delta answers at the last build, before the change');
  assert.ok(delta.ms < BUILD_MS / 2, `the delta read took ${delta.ms.toFixed(1)} ms, not a build's ${BUILD_MS} ms`);
  const landed = materializer.landed(board);
  await new Promise((done) => { const check = () => (landed.count() >= 1 ? done() : setTimeout(check, 10)); check(); });
  const later = await timedDelta(materializer, board, first.sequence);
  assert.ok(later.sequence > first.sequence, 'the build the change started catches the next delta up');
});

test('api.state-kept.restarted-server-restored-snapshot-answers: #6850 clause 1: on a restarted server a restored snapshot answers the waiting kept read, though the board moved after it was saved [A2,C7]', async (t) => {
  const { read } = await stubBoard(t, { restored: true });
  const kept = await read({ kept: true });
  assert.equal(kept.sequence, 0, 'the kept read takes the restored record, saved at an older revision');
  assert.ok(kept.ms < BUILD_MS / 2, `the kept read took ${kept.ms.toFixed(1)} ms, not the first build's ${BUILD_MS} ms`);
  const plain = await read();
  assert.ok(plain.sequence > 0, 'a plain read still waits for a build of the board as it is');
});

test('api.state-kept.build-lands-after-read-answered: #6850 clause 2: the build that lands after a read answered from an older one is announced once, and a plain read still returns the write it follows [A2,C7]', async (t) => {
  const { materializer, board, watched, read } = await stubBoard(t);
  const first = await read();
  const landed = materializer.landed(board);
  let heard = 0;
  const stop = landed.subscribe(() => { heard += 1; });
  t.after(stop);
  await read();
  await read({ kept: true });
  assert.equal(heard, 0, 'reads of an unchanged board announce nothing');
  watched.revision = 'r2';
  const behind = await read({ kept: true });
  assert.equal(behind.sequence, first.sequence, 'the kept read answers from the build before the change');
  await new Promise((done) => { const check = () => (landed.count() >= 1 ? done() : setTimeout(check, 10)); check(); });
  assert.equal(heard, 1, 'the landing build is announced once');
  assert.equal(landed.count(), 1);
  watched.revision = 'r3';
  const plain = await read();
  assert.ok(plain.sequence > behind.sequence + 1, 'a plain read after a change waits for the build that has it');
  assert.equal(heard, 1, 'a plain read is never answered from an older build, so its build is not announced');
});
