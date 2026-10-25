/** Authenticated API2 publication stays opaque, bounded and compatible with legacy heads [H15,H17,H18]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createRelayAuth } from '../relay/auth.js';
import { createGitHubClient } from '../relay/github.js';
import { createRelayHandler } from '../relay/service.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { generateBoardKey, seal } from '../src/seal.js';
import { readSealedDescriptor, readSealedValue, writeSealedDescriptor, writeSealedValue } from '../src/sealed-pages.js';
import { githubFixture } from './relay-fixture.js';

const BOARD = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

/** Create real private auth, journals and an HTTP relay; all credentials remain inside the fixture. */
async function fixture(t, accountStorageBytes) {
  const provider = await githubFixture(t);
  const root = mkdtempSync(join(tmpdir(), 'pullboard-page-http-'));
  const auth = createRelayAuth({ database: join(root, 'auth.sqlite'), github: createGitHubClient(provider.config) });
  const flow = auth.beginWeb();
  const redirect = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const callback = new URL(redirect.headers.get('location'));
  const signed = await auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), flow.binding);
  await auth.linkBoard(signed.token, BOARD, 'fixture/repository');
  await auth.linkBoard(signed.token, OTHER, 'fixture/repository-2'); // one team board per repository [E12]
  let handler;
  let clock = Date.now();
  const server = createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  handler = createRelayHandler({ directory: join(root, 'boards'), auth, publicOrigin: origin, maintenanceMs: 0, accountStorageBytes, now: () => clock });
  t.after(() => { server.closeAllConnections(); server.close(); handler.close(); auth.close(); rmSync(root, { recursive: true, force: true }); });
  const key = await generateBoardKey();
  /** Return only protocol responses, never bearer credentials, in assertion diagnostics. */
  async function call(method, path, body, token = signed.token, extra = {}) {
    const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + token,
      'x-pullboard-engine': String(ENGINE_VERSION), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, document: await response.json() };
  }
  /** Stage a genuine sealed value and its bounded encrypted directory through public HTTP routes. */
  async function stage(value, sequence = 0) {
    const began = await call('POST', '/api/v2/boards/' + BOARD + '/uploads', { sequence });
    assert.equal(began.status, 200, began.document.error?.message);
    const upload = began.document.upload;
    const context = { key, boardId: BOARD, sequence,
      async put(object) {
        const stored = await call('PUT', '/api/v2/boards/' + BOARD + '/uploads/' + upload.id + '/objects/' + object.id,
          { sequence: object.sequence, sealed: Buffer.from(object.bytes).toString('base64url'), children: object.children });
        if (stored.status !== 200) {
          const error = new Error(stored.document.error?.message ?? 'Synthetic page upload refused.');
          Object.assign(error, { code: stored.document.error?.code, status: stored.status, storage: stored.document.error?.storage });
          throw error;
        }
      } };
    const valueReference = await writeSealedValue(value, context);
    const reference = await writeSealedDescriptor({ format: 'synthetic-directory', value: valueReference }, [valueReference], context);
    return { upload, reference, context };
  }
  /** Publish one staged complete graph, retaining the actual relay's sequencing checks. */
  function publish(staged, initialOnly = false) {
    return call('POST', '/api/v2/boards/' + BOARD + '/uploads/' + staged.upload.id + '/publish', { root: staged.reference, initialOnly });
  }
  /** Read and authenticate only selected values, with the graph path anchored at a pinned root. */
  async function read(state, token = signed.token) {
    const context = { key, boardId: BOARD,
      async get(id, parents) {
        const path = '/api/v2/boards/' + BOARD + '/objects/' + id + '?pin=' + encodeURIComponent(state.read.id)
          + (parents.length ? '&via=' + encodeURIComponent(parents.join(',')) : '');
        const result = await call('GET', path, undefined, token);
        assert.equal(result.status, 200, result.document.error?.message);
        return Buffer.from(result.document.page.sealed, 'base64url');
      } };
    const directory = await readSealedDescriptor(state.root, context);
    return readSealedValue(directory.value.value, { ...context, parents: [state.root.id] });
  }
  return { root, auth, signed, origin, key, call, stage, publish, read, handler,
    /** Advance the private service clock to observe real staging expiry, without mutating its database. */
    advance(ms) { clock += ms; } };
}

test('API2 reads legacy heads and publishes opaque pages while old clients explicitly upgrade [H15,H17]', async t => {
  const box = await fixture(t);
  const capabilities = await box.call('GET', '/api/v2');
  assert.equal(capabilities.document.apiVersion, 2);
  const legacy = Buffer.from(await seal(box.key, Buffer.from('{"legacy":"fixture"}'), { boardId: BOARD, kind: 'snapshot', sequence: 0 })).toString('base64url');
  assert.equal((await box.call('PUT', '/api/v1/boards/' + BOARD + '/state', { sequence: 0, sealed: legacy })).status, 200);
  assert.equal((await box.call('GET', '/api/v1/boards/' + BOARD + '/state')).document.state.sealed, legacy);
  const old = await box.call('GET', '/api/v2/boards/' + BOARD + '/state');
  assert.equal(old.document.state.apiVersion, 1);
  assert.equal(old.document.state.sealed, legacy);
  const value = { marker: 'AUTHENTICATED_HISTORY_THROUGH_OPAQUE_PAGES', text: 'x'.repeat(600_000) };
  const staged = await box.stage(value);
  assert.equal((await box.publish(staged)).status, 200);
  const head = await box.call('GET', '/api/v2/boards/' + BOARD + '/state');
  assert.equal(head.document.state.root.id, staged.reference.id);
  const decoded = await box.read(head.document.state);
  assert.equal(decoded.marker, value.marker); assert.equal(decoded.text.length, value.text.length);
  const refused = await box.call('GET', '/api/v1/boards/' + BOARD + '/state');
  assert.equal(refused.document.error.code, 'RELAY_API_VERSION');
  assert.match(refused.document.error.message, /version 2.*npm i -g pullboard@latest/u);
  assert.equal((await box.call('PUT', '/api/v1/boards/' + BOARD + '/state', { sequence: 0, sealed: legacy })).document.error.code, 'RELAY_API_VERSION');
});

test('a pinned HTTP reader survives replacement and staged ids are not public read authority [H15,H17,H18]', async t => {
  const box = await fixture(t);
  const first = await box.stage({ marker: 'first complete head' });
  assert.equal((await box.publish(first, true)).status, 200);
  const old = (await box.call('GET', '/api/v2/boards/' + BOARD + '/state')).document.state;
  const move = Buffer.from(await seal(box.key, Buffer.from('synthetic opaque move'), { boardId: BOARD, kind: 'move', sequence: 1 })).toString('base64url');
  assert.equal((await box.call('POST', '/api/v1/boards/' + BOARD + '/moves', { sequence: 1, sealed: move })).status, 200);
  const next = await box.stage({ marker: 'second complete head' }, 1);
  assert.equal((await box.publish(next)).status, 200);
  assert.equal((await box.read(old)).marker, 'first complete head');
  const newest = (await box.call('GET', '/api/v2/boards/' + BOARD + '/state')).document.state;
  assert.equal((await box.read(newest)).marker, 'second complete head');
  const staged = await box.stage({ marker: 'not yet published' }, 1);
  const stolen = await box.call('GET', '/api/v2/boards/' + BOARD + '/objects/' + staged.reference.id + '?pin=' + old.read.id);
  assert.equal(stolen.status, 403); assert.equal(stolen.document.error.code, 'BAD_PAGE_PATH');
});

test('an account quota refusal preserves the readable head and is named in phone-facing APIs [H15,H17]', async t => {
  const box = await fixture(t, 2_000);
  const first = await box.stage({ marker: 'readable before quota' });
  assert.equal((await box.publish(first)).status, 200);
  await assert.rejects(box.stage({ text: randomBytes(8_000).toString('base64') }), error => error.code === 'ACCOUNT_STORAGE_LIMIT' && error.status === 507 && error.storage.account.id === box.signed.user.id);
  const head = await box.call('GET', '/api/v2/boards/' + BOARD + '/state');
  assert.equal(head.document.state.warning.code, 'ACCOUNT_STORAGE_LIMIT');
  assert.ok(head.document.state.warning.message.includes(box.signed.user.login));
  assert.equal((await box.read(head.document.state)).marker, 'readable before quota');
  const boards = await box.call('GET', '/api/v1/boards');
  assert.ok(boards.document.warnings.some(warning => warning.board === BOARD && warning.code === 'ACCOUNT_STORAGE_LIMIT'));
  const legacy = Buffer.from(await seal(box.key, randomBytes(8_000), { boardId: OTHER, kind: 'snapshot', sequence: 0 })).toString('base64url');
  const oldQuota = await box.call('PUT', '/api/v1/boards/' + OTHER + '/state', { sequence: 0, sealed: legacy });
  assert.equal(oldQuota.status, 507);
  assert.equal(oldQuota.document.error.code, 'ACCOUNT_STORAGE_LIMIT');
  assert.equal(oldQuota.document.error.storage.account.id, box.signed.user.id, 'legacy clients receive the same authenticated quota identity and totals');
  assert.equal((await box.call('POST', '/api/v2/boards/' + BOARD + '/uploads', { sequence: 0, account: 'another-account' })).document.error.code, 'BAD_REQUEST');
  assert.equal((await box.call('DELETE', '/api/v1/boards/' + BOARD)).status, 200);
  await box.auth.linkBoard(box.signed.token, BOARD, 'fixture/repository');
  const relinked = await box.call('GET', '/api/v1/boards');
  assert.ok(!(relinked.document.warnings ?? []).some(warning => warning.board === BOARD && warning.code === 'ACCOUNT_STORAGE_LIMIT'),
    'unlink clears the prior failed-upload notice before a fresh link has its first snapshot');
});

test('all page reads reauthorize the board and a readable agent cannot replace a snapshot [H15,H17]', async t => {
  const box = await fixture(t);
  const staged = await box.stage({ marker: 'authorized page' });
  assert.equal((await box.publish(staged)).status, 200);
  const agent = await box.auth.issueToken(box.signed.token, { board: BOARD, agent: 'page-observer' });
  const state = await box.call('GET', '/api/v2/boards/' + BOARD + '/state', undefined, agent.token);
  assert.equal(state.status, 200);
  assert.equal((await box.read(state.document.state, agent.token)).marker, 'authorized page');
  assert.equal((await box.call('POST', '/api/v2/boards/' + BOARD + '/uploads', { sequence: 0 }, agent.token)).status, 403);
  assert.equal((await box.call('GET', '/api/v2/boards/' + OTHER + '/state', undefined, agent.token)).status, 403);
  await box.auth.revoke(box.signed.token, agent.id);
  const after = await box.call('GET', '/api/v2/boards/' + BOARD + '/objects/' + state.document.state.root.id + '?pin=' + state.document.state.read.id, undefined, agent.token);
  assert.equal(after.status, 401, 'a previously issued read pin never bypasses revocation');
});

test('a consistent journal backup carries every opaque page and unlink removes the complete copy [H15,H18]', async t => {
  const box = await fixture(t);
  const staged = await box.stage({ marker: 'BACKUP_HAS_SEALED_HISTORY', text: 'b'.repeat(600_000) });
  assert.equal((await box.publish(staged)).status, 200);
  const backups = box.handler.backup();
  const name = backups.written.find(value => value.startsWith(BOARD + '.'));
  assert.ok(name, 'the ordinary retention backup includes this board');
  const source = new DatabaseSync(join(box.root, 'boards-backups', name), { readOnly: true });
  try {
    assert.ok(source.prepare('SELECT COUNT(*) AS count FROM page_object').get().count > 1);
    assert.equal(source.prepare('SELECT api_version FROM journal_snapshot WHERE slot=1').get().api_version, 2);
  } finally { source.close(); }
  assert.equal((await box.call('DELETE', '/api/v1/boards/' + BOARD)).status, 200);
  assert.equal((await box.call('GET', '/api/v2/boards/' + BOARD + '/state')).status, 404);
});


test('small authenticated storage probes collect expired staging across the account without downloading a snapshot [H15,H17,H18]', async t => {
  const box = await fixture(t, 12_000);
  const empty = await box.call('GET', '/api/v2/boards/' + BOARD + '/storage');
  assert.equal(empty.status, 200); assert.equal(empty.document.storage.usedBytes, 0);
  const first = await box.stage({ marker: 'retained current head' });
  assert.equal((await box.publish(first)).status, 200);
  await box.stage({ text: randomBytes(8_000).toString('base64') });
  await assert.rejects(box.stage({ text: randomBytes(8_000).toString('base64') }), { code: 'ACCOUNT_STORAGE_LIMIT' });
  const blocked = await box.call('GET', '/api/v2/boards/' + OTHER + '/storage');
  assert.ok(blocked.document.storage.usedBytes > 8_000);
  const own = await box.call('GET', '/api/v2/boards/' + BOARD + '/storage');
  assert.equal(own.document.warning.code, 'ACCOUNT_STORAGE_LIMIT');
  box.advance(3_600_001);
  const collected = await box.call('GET', '/api/v2/boards/' + OTHER + '/storage');
  assert.ok(collected.document.storage.usedBytes < 2_000, 'another linked board can release expired staging charged to the same account');
  const ready = await box.call('GET', '/api/v2/boards/' + BOARD + '/storage');
  assert.equal(ready.document.warning, undefined);
  assert.ok(JSON.stringify(ready.document).length < 2048);
  assert.deepEqual(Object.keys(ready.document).sort(), ['apiVersion', 'storage', 'version']);
  const head = await box.call('GET', '/api/v2/boards/' + BOARD + '/state');
  assert.equal((await box.read(head.document.state)).marker, 'retained current head');
  const invalid = await box.call('GET', '/api/v2/boards/' + BOARD + '/storage', undefined, 'pa_' + 'x'.repeat(43));
  assert.equal(invalid.status, 401);
});
