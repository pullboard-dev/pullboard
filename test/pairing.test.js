/** One-time pairing keeps its secret off the relay and rejects replay or expiry [H15,H17]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPairingCode, openPairingBundle, parsePairingCode, sealPairingBundle } from '../src/pairing.js';
import { createPairingStore } from '../relay/pairing-store.js';
import { createPairingHandler } from '../relay/pairing-http.js';
import { createRelayHandler } from '../relay/service.js';
import { Refused } from '../src/refused.js';
import { relayClientFixture } from './relay-client-fixture.js';

const BOARD = '0123456789abcdef0123456789abcdef';

/** Serve only the pairing adapter on a private loopback port for actual HTTP boundary checks. */
async function servePairing(t, authorize, pairings = createPairingStore()) {
  const handler = createPairingHandler({ authenticate: authorize, pairings });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}

/** Create the exact native-export envelope expected from a linked device. */
function bundle(overrides = {}) {
  return {
    version: 1, board: BOARD, url: 'https://app.pullboard.dev', repository: 'owner/repository', mode: 'mirror',
    sequence: 9, cursor: 14, key: 'A'.repeat(43), snapshot: { version: 1, tables: {
      board_meta: [{ meta_key: 'board_id', meta_value: BOARD }], event: [{ event_id: 14 }],
    } },
    ...overrides,
  };
}

test('[H15,H17] client seals board key and native snapshot under a one-time code the relay cannot read', async () => {
  const issued = createPairingCode(BOARD);
  assert.match(issued.locator, /^[A-Za-z0-9_-]{22}$/);
  assert.match(issued.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(parsePairingCode(issued.code).locator, issued.locator);
  assert.equal(parsePairingCode(issued.code).board, BOARD);
  const sealed = await sealPairingBundle(issued.code, bundle());
  assert.match(sealed, /^[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.includes(issued.secret), 'the relay envelope does not contain the human-held code secret');
  assert.ok(!sealed.includes(bundle().key), 'the relay envelope does not contain the board key as readable text');
  assert.deepEqual(await openPairingBundle(issued.code, sealed), bundle());

  const ordered = bundle({ mode: 'ordered', sequence: 14, snapshot: { version: 1, tables: {
    board_meta: [
      { meta_key: 'board_id', meta_value: BOARD },
      { meta_key: 'relay_applied_sequence', meta_value: '14' },
      { meta_key: 'relay_engine_version', meta_value: '1' },
    ],
    event: [{ event_id: 14 }],
  } } });
  assert.deepEqual(await openPairingBundle(issued.code, await sealPairingBundle(issued.code, ordered)), ordered,
    'ordered pairing binds the native checkpoint to the acknowledged relay sequence');

  const tampered = sealed.slice(0, -1) + (sealed.endsWith('A') ? 'B' : 'A');
  await assert.rejects(openPairingBundle(issued.code, tampered), { code: 'PAIR_CODE_INVALID' });
  const wrong = createPairingCode(BOARD);
  await assert.rejects(openPairingBundle(wrong.code, sealed), { code: 'PAIR_CODE_INVALID' });
});

test('[H15,H17] package validation excludes sender credentials and validates relay and board identity', async () => {
  const { code } = createPairingCode(BOARD);
  for (const invalid of [
    { ...bundle(), token: 'ps_' + 'x'.repeat(43) },
    bundle({ board: '../outside' }),
    bundle({ repository: 'owner' }),
    bundle({ url: 'https://user:secret@example.test' }),
    bundle({ sequence: -1 }),
    bundle({ cursor: 1.5 }),
    bundle({ key: 'x'.repeat(42) }),
    bundle({ snapshot: { version: 2, tables: {} } }),
    bundle({ mode: 'ordered' }),
    bundle({ mode: 'ordered', sequence: 14, snapshot: { version: 1, tables: {
      board_meta: [{ meta_key: 'board_id', meta_value: BOARD }, { meta_key: 'relay_applied_sequence', meta_value: '14' }, { meta_key: 'relay_engine_version', meta_value: '1' }],
      event: [{ event_id: 13 }],
    } } }),
  ]) {
    await assert.rejects(sealPairingBundle(code, invalid), { code: 'PAIR_PACKAGE' });
  }
  const oversized = bundle({ snapshot: { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: BOARD }], event: [{ event_id: 14 }], marker: [{ value: 'x'.repeat(14_000_000) }],
  } } });
  await assert.rejects(sealPairingBundle(code, oversized), { code: 'PAIR_PACKAGE_SIZE' });
  for (const invalid of ['', 'abc', 'x'.repeat(98), BOARD + '.A'.repeat(22) + '.B'.repeat(43), null]) {
    assert.throws(() => parsePairingCode(invalid), { code: 'PAIR_CODE_INVALID' });
  }
});

test('[H15,H17] relay pairing envelopes expire after ten minutes and are consumed exactly once', () => {
  let now = 1_800_000_000_000;
  const store = createPairingStore({ now: () => now, maxCodes: 2 });
  const first = createPairingCode(BOARD);
  const firstEnvelope = 'A'.repeat(60);
  assert.deepEqual(store.publish(BOARD, first.locator, firstEnvelope), { expiresIn: 600 });
  assert.deepEqual(store.consume(BOARD, first.locator), { sealed: firstEnvelope });
  assert.throws(() => store.consume(BOARD, first.locator), { code: 'PAIR_CODE_USED' });
  assert.equal(store.size(), 1, 'the store retains a small tombstone so reuse has a precise refusal');

  const expired = createPairingCode(BOARD);
  store.publish(BOARD, expired.locator, 'B'.repeat(60));
  now += 600_000;
  assert.throws(() => store.consume(BOARD, expired.locator), { code: 'PAIR_CODE_EXPIRED' });
  assert.throws(() => store.consume(BOARD, 'C'.repeat(22)), { code: 'PAIR_CODE_UNKNOWN' });
  now += 600_000;
  assert.equal(store.size(), 0, 'expired and used tombstones are eventually pruned');
});

test('[H15,H17] relay refuses malformed, duplicate and over-capacity pairing envelopes', () => {
  const store = createPairingStore({ maxCodes: 1 });
  const first = createPairingCode(BOARD);
  assert.throws(() => store.publish(BOARD, first.locator, 'not base64!'), { code: 'PAIR_PACKAGE' });
  store.publish(BOARD, first.locator, 'A'.repeat(60));
  assert.throws(() => store.publish(BOARD, first.locator, 'A'.repeat(60)), { code: 'PAIR_EXISTS' });
  const second = createPairingCode(BOARD);
  assert.throws(() => store.publish(BOARD, second.locator, 'B'.repeat(60)), { code: 'PAIR_BUSY' });
  assert.throws(() => createPairingStore({ ttl: 1 }), { code: 'PAIR_CONFIG' });
});

test('[H15,H17] pairing HTTP authenticates repository access before publishing or consuming', async (t) => {
  let allowed = true;
  const checks = [];
  const origin = await servePairing(t, async (req, { board, write }) => {
    checks.push({ credential: req.headers.authorization, board, write });
    if (!allowed) throw new Refused('NO_REPO_ACCESS', 'ask the repository owner for read access');
    if (req.headers.authorization !== 'Bearer receiver-session') throw new Refused('AUTH_REQUIRED', 'sign in');
  });
  const issued = createPairingCode(BOARD);
  const sealed = await sealPairingBundle(issued.code, bundle());
  const base = origin + '/api/v1/pairings/' + BOARD + '/' + issued.locator;
  const publish = await fetch(base, {
    method: 'POST', headers: { authorization: 'Bearer receiver-session', 'content-type': 'application/json' },
    body: JSON.stringify({ sealed }),
  });
  assert.equal(publish.status, 201);
  assert.equal(publish.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await publish.json(), { version: 1, expiresIn: 600 });

  allowed = false;
  const blocked = await fetch(base + '/consume', {
    method: 'POST', headers: { authorization: 'Bearer receiver-session', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, 'NO_REPO_ACCESS');
  allowed = true;
  const consumed = await fetch(base + '/consume', {
    method: 'POST', headers: { authorization: 'Bearer receiver-session', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(consumed.status, 200);
  const response = await consumed.json();
  assert.equal(response.sealed, sealed);
  assert.ok(!JSON.stringify(response).includes(issued.secret), 'HTTP returns opaque ciphertext only');
  assert.deepEqual(await openPairingBundle(issued.code, response.sealed), bundle(),
    'the authorized receiver can decrypt the same package after the rejected attempt');
  assert.ok(checks.every((check) => check.board === BOARD && check.write === false));

  const replay = await fetch(base + '/consume', {
    method: 'POST', headers: { authorization: 'Bearer receiver-session', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal((await replay.json()).error.code, 'PAIR_CODE_USED');
});

test('[H15,H17] relay service holds only bounded opaque pairing bytes and preserves its existing board files', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-pair-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const boardFile = join(root, 'existing.journal.sqlite');
  const marker = Buffer.from('existing relay journal fixture');
  writeFileSync(boardFile, marker, { mode: 0o600 });
  const sourceToken = 'ps_' + 'S'.repeat(43);
  const receiverToken = 'ps_' + 'R'.repeat(43);
  const blockedToken = 'ps_' + 'B'.repeat(43);
  const links = new Map([[BOARD, { id: BOARD, repository: 'owner/repository', linkedAt: Date.now() }]]);
  const auth = {
    async authenticate(token, { board } = {}) {
      if (![sourceToken, receiverToken, blockedToken].includes(token)) throw new Refused('AUTH_REQUIRED', 'sign in');
      if (board && !links.has(board)) throw new Refused('BOARD_NOT_LINKED', 'link the board');
      if (token === blockedToken) throw new Refused('NO_REPO_ACCESS', 'ask the repository owner for read access');
      return { id: token, kind: 'session', user: { id: token, login: 'fixture' } };
    },
    linkedBoards() { return [...links.values()]; },
    withBoard(board, work) {
      const link = links.get(board);
      if (!link) throw new Refused('BOARD_NOT_LINKED', 'link the board');
      return work(link);
    },
    forgetBoard(board) { links.delete(board); },
    pendingCleanup() { return []; },
    finishCleanup() {},
    withCleanup(_board, work) { return work(); },
  };
  const service = createRelayHandler({ directory: root, auth, maintenanceMs: 0 });
  const server = createServer((req, res) => { void service(req, res); });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const issued = createPairingCode(BOARD);
  const sealed = await sealPairingBundle(issued.code, bundle());
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1/pairings/' + BOARD + '/' + issued.locator;
  const published = await fetch(base, {
    method: 'POST', headers: { authorization: 'Bearer ' + sourceToken, 'content-type': 'application/json' },
    body: JSON.stringify({ sealed }),
  });
  assert.equal(published.status, 201);
  const unauthorized = await fetch(base + '/consume', {
    method: 'POST', headers: { authorization: 'Bearer ' + blockedToken, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal((await unauthorized.json()).error.code, 'NO_REPO_ACCESS');
  const consumed = await fetch(base + '/consume', {
    method: 'POST', headers: { authorization: 'Bearer ' + receiverToken, 'content-type': 'application/json' }, body: '{}',
  });
  const response = await consumed.json();
  assert.equal(consumed.status, 200);
  assert.deepEqual(await openPairingBundle(issued.code, response.sealed), bundle());
  assert.deepEqual(readFileSync(boardFile), marker, 'pairing does not replace or rewrite a journal');
  assert.deepEqual(readdirSync(root).sort(), ['existing.journal.sqlite'], 'pairing bytes stay in bounded memory, not durable relay storage');
});

test('[H15,H17] production CLI pairs a real second clone and reads the same board', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const printed = await box.cli('relay', 'pair');
  assert.equal(printed.code, 0, 'the linked CLI publishes a one-use pairing envelope');
  assert.match(printed.document.code, /^[0-9a-f]{32}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(printed.document.expiresIn, 600);
  assert.match(printed.document.link, /^https:\/\/app\.pullboard\.dev\/#board=/);
  const paired = await box.otherDeviceJoin(printed.document.code);
  assert.equal(paired.joined.board, box.before.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value);
  assert.deepEqual(paired.exported, box.before, 'the second clone imports the same native rows and counters');
  assert.ok(!box.calls.some((call) => call.path.includes(printed.document.code)), 'the code secret never appears in a relay request path');
});
