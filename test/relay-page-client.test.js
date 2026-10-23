/** Durable device cache and bounded native protocol retries, using real crypto and journal storage [H15,H17]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createRelayJournal } from '../relay/journal.js';
import { snapshotPageRoot } from '../relay/pages-http.js';
import { createRelayPageCache, snapshotSourceId } from '../src/relay-page-cache.js';
import { pagedSnapshotRequest, relaySnapshotRequest, relayStorage, relayStorageLine } from '../src/relay-page-client.js';
import { generateBoardKey } from '../src/seal.js';
import { writeSealedValue, sealedPageFingerprint } from '../src/sealed-pages.js';
import { Refused } from '../src/refused.js';
import { createServer } from 'node:http';
import { relayFixtureChild, cliChildDeadlineMs } from './relay-client-fixture.js';

/** Use only an isolated device home, restoring the surrounding test process after its cache closes. */
function privateHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-private-page-client-'));
  const old = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = join(root, 'device');
  t.after(() => { if (old === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = old; rmSync(root, { recursive: true, force: true }); });
  return root;
}

/** Dispatch the client's actual API2 objects against real journal/page transactions; HTTP auth has its separate tests. */
async function fixture(t) {
  const root = privateHome(t);
  const state = { board: 'a'.repeat(32), url: 'https://synthetic-relay.example' };
  const key = await generateBoardKey();
  const journal = createRelayJournal({ directory: join(root, 'journal'), boardId: state.board });
  const pages = journal.pages();
  t.after(() => { pages.close(); journal.close(); });
  const principal = { kind: 'machine', userId: 'fixture-account', machine: 'fixture-machine' };
  const storage = { account: { id: 'fixture-account', login: 'fixture-login' }, usedBytes: 0, limitBytes: 256_000_000 };
  const calls = [];
  let loseObjectAck = false, corruptRootAck = false;
  /** Preserve a strict bounded upload shape while returning the real storage's idempotent acknowledgements. */
  async function request(path, options = {}) {
    const body = options.body;
    calls.push({ path, method: options.method ?? 'GET', bytes: body ? Buffer.byteLength(JSON.stringify(body)) : 0,
      digest: body?.sealed ? snapshotSourceId(body.sealed) : null });
    const suffix = path.slice(('/api/v2/boards/' + state.board).length);
    if (suffix === '/uploads') return { apiVersion: 2, storage, upload: body.resume ? pages.resume(body.resume, principal, body.sequence) : pages.begin(principal, body.sequence) };
    const put = /^\/uploads\/([^/]+)\/objects\/([0-9a-f]{64})$/u.exec(suffix);
    if (put) {
      assert.deepEqual(Object.keys(body).sort(), ['children', 'sealed', 'sequence']);
      assert.ok(calls.at(-1).bytes < 600_000);
      const stored = pages.put(put[1], principal, { id: put[2], sequence: body.sequence, bytes: Buffer.from(body.sealed, 'base64url'), children: body.children });
      if (loseObjectAck) { loseObjectAck = false; throw new Refused('RELAY_UNAVAILABLE', 'Synthetic lost object ACK.'); }
      return { apiVersion: 2, page: stored };
    }
    const publish = /^\/uploads\/([^/]+)\/publish$/u.exec(suffix);
    if (publish) {
      const saved = pages.publish(publish[1], principal, body.root, (ref, bytes) => journal.saveSnapshot(ref.sequence, bytes, principal, { apiVersion: 2, pageBytes: ref.bytes }));
      pages.prune([body.root.id]);
      const result = { apiVersion: 2, state: { root: snapshotPageRoot(saved), sequence: saved.sequence, storage } };
      if (corruptRootAck) result.state.root.id = 'f'.repeat(64);
      return result;
    }
    if (suffix === '/state') {
      const saved = journal.snapshot();
      const reference = snapshotPageRoot(saved);
      return { apiVersion: 2, state: { ...saved, apiVersion: 2, root: reference, read: pages.pin(principal, reference), storage } };
    }
    const get = /^\/objects\/([0-9a-f]{64})\?(.+)$/u.exec(suffix);
    if (get) {
      const query = new URLSearchParams(get[2]);
      const object = pages.get(query.get('pin'), principal, get[1], query.get('via') ? query.get('via').split(',') : []);
      return { apiVersion: 2, page: { id: object.id, sequence: object.sequence, sealed: object.bytes.toString('base64url'), children: object.children } };
    }
    throw new Error('Unexpected synthetic API2 route.');
  }
  const shouts = [{ shout_id: 1, shout_text: randomBytes(700_000).toString('base64'), shout_decision: 0, shout_answers: null }];
  const document = { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: state.board }, { meta_key: 'relay_engine_version', meta_value: '56' }, { meta_key: 'relay_applied_sequence', meta_value: '0' }],
    shout: shouts, event: [], item: [], agent: [], verdict: [], sqlite_sequence: [{ name: 'shout', seq: 19 }],
  }, presentation: { version: 1, config: {}, state: { items: [], agents: [], shouts: [], decisions: [], asked: [], events: [], holds: [], spec: [], practice: [], lanes: [], owning: [] }, shouts } };
  const adapter = { request, key, maxEngine: 56, decode: async () => structuredClone(document), encode: async value => JSON.stringify(value) };
  return { state, document, adapter, calls, pages, journal, principal,
    loseObjectAck() { loseObjectAck = true; }, corruptRootAck() { corruptRootAck = true; } };
}

test('paged upload ACK tolerates a concurrent cache commit during an awaited PUT [H15,H17]', async t => {
  const box = await fixture(t), writer = createRelayPageCache(box.state);
  t.after(() => writer.close());
  const request = box.adapter.request;
  let committed = false;
  /** Return the real page ACK only after a second connection commits across the await. */
  box.adapter.request = async (path, options) => {
    const response = await request(path, options);
    if (!committed && /\/objects\/[0-9a-f]{64}$/u.test(path)) {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(writer.firstNotice(snapshotSourceId('concurrent-upload-notice')), true);
      committed = true;
    }
    return response;
  };
  const pending = { sequence: 0, sealed: 'synthetic-concurrent-upload' };
  const result = await pagedSnapshotRequest(box.state, { method: 'PUT', body: pending }, box.adapter);
  assert.equal(committed, true);
  assert.equal(result.state.sealed, pending.sealed);
  assert.ok(box.calls.filter(call => call.method === 'PUT').length > 8, 'the real encrypted graph is streamed');
  assert.deepEqual([...writer.pending(snapshotSourceId(pending.sealed))], []);
  assert.deepEqual(JSON.parse((await pagedSnapshotRequest(box.state, {}, box.adapter)).state.sealed), box.document);
});

test('a lost object ACK resumes the exact durable graph and native restore preserves all rows [H15,H17]', async t => {
  const box = await fixture(t);
  const pending = { sequence: 0, sealed: 'synthetic-original-pending-cipher' };
  box.loseObjectAck();
  await assert.rejects(pagedSnapshotRequest(box.state, { method: 'PUT', body: pending }, box.adapter), { code: 'RELAY_UNAVAILABLE' });
  assert.equal(box.journal.snapshot(), null, 'a partially uploaded graph is never installed');
  const first = box.calls.find(call => call.method === 'PUT');
  const result = await pagedSnapshotRequest(box.state, { method: 'PUT', body: pending }, box.adapter);
  assert.equal(result.state.sealed, pending.sealed, 'the existing retry carrier is acknowledged only after an exact root ACK');
  const retries = box.calls.filter(call => call.path === first.path && call.method === 'PUT');
  assert.equal(retries.length, 2); assert.equal(retries[0].digest, retries[1].digest);
  assert.ok(box.calls.some(call => call.path.endsWith('/uploads') && call.method === 'POST'));
  const read = await pagedSnapshotRequest(box.state, {}, box.adapter);
  assert.deepEqual(JSON.parse(read.state.sealed), box.document);
  assert.equal(box.state.storage.account.login, 'fixture-login');
});

test('a fresh device reuses authenticated restored history instead of uploading it again [H15,H17]', async t => {
  const box = await fixture(t);
  await pagedSnapshotRequest(box.state, { method: 'PUT', body: { sequence: 0, sealed: 'first-device-cipher' } }, box.adapter);
  const initialObjects = box.calls.filter(call => call.method === 'PUT').map(call => call.path.split('/').at(-1));
  assert.ok(initialObjects.length > 8, 'the fixture has several genuine historical cipher pages');
  // Change only the private device home: the second device has none of the writer's cache or ACKs.
  process.env.PULLBOARD_HOME = join(process.env.PULLBOARD_HOME, 'independent-reader');
  const read = await pagedSnapshotRequest(box.state, {}, box.adapter);
  assert.deepEqual(JSON.parse(read.state.sealed), box.document, 'the fresh device authenticates and restores every native row');
  const afterRead = box.calls.length;
  box.document.presentation.state.name = 'New device presentation';
  const result = await pagedSnapshotRequest(box.state, { method: 'PUT', body: { sequence: 0, sealed: 'second-device-cipher' } }, box.adapter);
  const writes = box.calls.slice(afterRead).filter(call => call.method === 'PUT');
  assert.ok(writes.length < initialObjects.length / 2, 'changing only current presentation must not upload retained history again');
  assert.equal(writes.filter(call => initialObjects.includes(call.path.split('/').at(-1))).length, 0, 'no authenticated historical object is uploaded again');
  assert.equal(result.state.sealed, 'second-device-cipher');
  assert.deepEqual(JSON.parse((await pagedSnapshotRequest(box.state, {}, box.adapter)).state.sealed), box.document,
    'the independently published checkpoint still restores all native rows and the changed presentation');
});

test('a collected remote subtree is restaged despite old cached ACKs, without replacing the source graph [H15,H17]', async t => {
  const box = await fixture(t);
  const pending = { sequence: 0, sealed: 'synthetic-stable-pending-cipher' };
  const first = await pagedSnapshotRequest(box.state, { method: 'PUT', body: pending }, box.adapter);
  const count = box.calls.filter(call => call.method === 'PUT').length;
  box.pages.prune([]);
  const second = await pagedSnapshotRequest(box.state, { method: 'PUT', body: pending }, box.adapter);
  assert.equal(second.state.root.id, first.state.root.id);
  assert.ok(box.calls.filter(call => call.method === 'PUT').length > count);
  assert.deepEqual(JSON.parse((await pagedSnapshotRequest(box.state, {}, box.adapter)).state.sealed), box.document);
});

test('an incorrect root ACK never completes or discards the private durable upload [H15,H17]', async t => {
  const box = await fixture(t);
  const pending = { sequence: 0, sealed: 'synthetic-ack-check' };
  box.corruptRootAck();
  await assert.rejects(pagedSnapshotRequest(box.state, { method: 'PUT', body: pending }, box.adapter), { code: 'RELAY_RESPONSE' });
  const cache = createRelayPageCache(box.state);
  try { assert.ok(cache.job(snapshotSourceId(pending.sealed))); } finally { cache.close(); }
});

test('cache hits from a prior key are misses while actual encrypted reads still refuse the wrong key [H15,H17]', async t => {
  privateHome(t);
  const state = { board: 'c'.repeat(32), url: 'https://synthetic-relay.example' };
  const cache = createRelayPageCache(state);
  const first = { key: await generateBoardKey(), boardId: state.board, sequence: 0, put: cache.put, get: id => cache.object(id).bytes };
  try {
    const reference = await writeSealedValue({ marker: 'private native source' }, first);
    const hash = await sealedPageFingerprint(reference, first);
    cache.remember(hash, reference);
    const relinked = { ...first, key: await generateBoardKey() };
    assert.equal(await cache.lookup(hash, relinked), null, 'the old-key hint is not reused for a new upload');
    await assert.rejects(sealedPageFingerprint(reference, relinked), { code: 'SEAL_AUTH_FAILED' }, 'an actual wrong-key encrypted read stays refused');
    assert.deepEqual(await cache.lookup(hash, first), reference, 'the original authenticated object remains intact for its key');
  } finally { cache.close(); }
});

test('private reuse authenticates the fingerprint binding rather than trusting an unrelated cached page [H15,H17]', async t => {
  privateHome(t);
  const state = { board: 'b'.repeat(32), url: 'https://synthetic-relay.example' };
  const cache = createRelayPageCache(state);
  const context = { key: await generateBoardKey(), boardId: state.board, sequence: 0, put: cache.put };
  try {
    const ref = await writeSealedValue({ marker: 'private-data' }, context);
    cache.remember('f'.repeat(64), ref);
    await assert.rejects(cache.lookup('f'.repeat(64), context), { code: 'RELAY_PAGE_CACHE' });
  } finally { cache.close(); }
});

test('a stalled API2 upload is killed at its finite work-derived deadline and names the stall [C7,H15,H17]', async t => {
  const work = { legacyUploads: 0, pageUploadBytes: 0, pageSessions: 0, pageCheckpointAttempts: 0 };
  let held = false;
  const api = '/api/v2/boards/' + 'b'.repeat(32);
  const objectPath = api + '/uploads/stalled-fixture/objects/' + 'c'.repeat(64);
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === api + '/uploads') {
      work.pageSessions++; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return;
    }
    if (request.method === 'PUT' && request.url === objectPath) {
      request.on('data', bytes => { work.pageUploadBytes += bytes.byteLength; });
      request.on('end', () => { held = true; }); // Deliberately never acknowledge this genuinely received page.
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const script = `await (await fetch(${JSON.stringify(origin + api + '/uploads')}, {method:'POST'})).arrayBuffer();
    await fetch(${JSON.stringify(origin + objectPath)}, {method:'PUT',body:new Uint8Array(1024)});`;
  let failure;
  try { await relayFixtureChild(process.cwd(), process.env, ['--input-type=module', '-e', script], () => work, 0); }
  catch (error) { failure = error; }
  assert.equal(held, true, 'the stand-in really received the upload and withheld its ACK');
  assert.equal(work.pageSessions, 1);
  assert.equal(work.pageUploadBytes, 1024);
  assert.ok(failure, 'a real stalled child must fail rather than complete or wait without a bound');
  assert.match(failure.message, /signal: SIGKILL/u);
  assert.match(failure.message, /API2 page upload stalled/u);
  assert.ok(failure.message.includes('upload-derived child deadline ' + cliChildDeadlineMs(2) + 'ms exceeded'),
    'the observed session and one bounded byte unit determine the unchanged allowance');
  t.diagnostic(JSON.stringify({ stalledUploadWork: work, derivedDeadlineMs: cliChildDeadlineMs(2), stalledUploadKilled: true }));
});

test('account status has a validated identity, exact byte counts and a clear operator-set limit [H15,H17]', () => {
  const storage = { account: { id: 'account-1', login: 'owner-login' }, usedBytes: 251_000_000, limitBytes: 256_000_000 };
  assert.deepEqual(relayStorage(storage), storage);
  assert.equal(relayStorageLine(storage), 'relay storage: account owner-login, 251.0 MB used of 256.0 MB');
  assert.equal(relayStorage({ ...storage, account: { ...storage.account, login: 'Bearer private text' } }), null);
  assert.equal(relayStorage({ ...storage, usedBytes: -1 }), null);
});

test('oversize native uploads negotiate API2, native reads upgrade explicitly, and a paged board never downgrades [H15,H17]', async t => {
  const box = await fixture(t);
  const pending = { sequence: 0, sealed: 'synthetic-large-legacy-carrier' };
  const oldPath = '/api/v1/boards/' + box.state.board + '/state';
  const calls = [];
  let advertised = 2, persisted = 0;
  const hooks = { ...box.adapter, key: () => box.adapter.key, legacyLimit: 1, persist() { persisted++; },
    /** The adapter must never send an oversized legacy body before negotiating bounded pages. */
    async raw(path, options) {
      calls.push(path);
      if (path === '/api/v2') return { version: 1, apiVersion: advertised };
      if (path === oldPath) { assert.notEqual(options.method, 'PUT'); throw new Refused('RELAY_API_VERSION', 'Use API2.'); }
      return box.adapter.request(path, options);
    },
  };
  const written = await relaySnapshotRequest(box.state, oldPath, { method: 'PUT', body: pending }, {}, hooks);
  assert.equal(written.state.sealed, pending.sealed);
  assert.equal(box.state.snapshotApiVersion, 2);
  assert.ok(!calls.includes(oldPath), 'the oversized wire body never reaches API1');
  delete box.state.snapshotApiVersion;
  const read = await relaySnapshotRequest(box.state, oldPath, {}, {}, hooks);
  assert.deepEqual(JSON.parse(read.state.sealed), box.document);
  assert.equal(box.state.snapshotApiVersion, 2);
  assert.equal(persisted, 2);
  advertised = 1;
  await assert.rejects(relaySnapshotRequest(box.state, oldPath, {}, {}, hooks), { code: 'RELAY_API_VERSION' });
});

test('a relay without API2 retains legacy snapshot behavior rather than guessing a new wire format [H15,H17]', async () => {
  const state = { board: 'a'.repeat(32), url: 'https://synthetic-legacy.example' };
  const path = '/api/v1/boards/' + state.board + '/state';
  const calls = [];
  const response = { version: 1, state: { sealed: 'legacy-ack' } };
  const hooks = { legacyLimit: 1,
    /** An old relay has no capability route and only accepts its original snapshot interface. */
    async raw(target) {
      calls.push(target);
      if (target === '/api/v2') throw Object.assign(new Refused('BAD_REQUEST', 'Legacy relay route.'), { httpStatus: 404, relayVersion: 1 });
      assert.equal(target, path); return response;
    },
  };
  assert.equal(await relaySnapshotRequest(state, path, { method: 'PUT', body: { sealed: 'long' } }, {}, hooks), response);
  assert.deepEqual(calls, ['/api/v2', path]);
  assert.equal(state.snapshotApiVersion, undefined);
});


test('an API1 BAD_REQUEST capability response keeps small legacy uploads usable without a key read [H15,H17]', async () => {
  const state = { board: 'a'.repeat(32), url: 'https://synthetic-legacy-route.example' };
  const path = '/api/v1/boards/' + state.board + '/state';
  const response = { version: 1, state: { sequence: 0, sealed: 'old-saved-carrier' } };
  const hooks = { legacyLimit: 10_000_000,
    /** An older shared router refuses unknown paths with BAD_REQUEST, not necessarily 404. */
    async raw(target) {
      if (target === '/api/v2') throw Object.assign(new Refused('BAD_REQUEST', 'Use API1.'), { httpStatus: 400, relayVersion: 1 });
      assert.equal(target, path); return response;
    },
    /** A legacy retry of already captured bytes does not need an API2 decode or private key. */
    key() { assert.fail('unsupported capabilities must preserve the saved legacy carrier'); },
  };
  assert.equal(await relaySnapshotRequest(state, path, { method: 'PUT', body: response.state }, {}, hooks), response);
});

test('new snapshots on a capable relay use complete paged history even for a small board [H15,H17]', async t => {
  const box = await fixture(t);
  box.document.tables.shout[0].shout_text = 'tiny retained history';
  assert.ok(Buffer.byteLength(JSON.stringify(box.document)) < 900_000);
  const pending = { sequence: 0, sealed: 'synthetic-small-native-carrier' };
  const path = '/api/v1/boards/' + box.state.board + '/state';
  const hooks = { ...box.adapter, key: () => box.key ?? box.adapter.key, legacyLimit: 10_000_000, persist() {},
    /** Legacy reads remain supported, but a new capable writer should publish the complete page graph. */
    async raw(target, options) {
      if (target === '/api/v2') return { version: 1, apiVersion: 2 };
      if (target === path) return { version: 1, state: { ...pending } };
      return box.adapter.request(target, options);
    },
  };
  const result = await relaySnapshotRequest(box.state, path, { method: 'PUT', body: pending }, {}, hooks);
  assert.equal(box.state.snapshotApiVersion, 2, 'small boards receive the same complete-history transport, not a legacy presentation-only read');
  assert.ok(result.state.root);
  assert.deepEqual(JSON.parse((await pagedSnapshotRequest(box.state, {}, box.adapter)).state.sealed), box.document);
});
