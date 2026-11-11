/** One-time pairing keeps its secret off the relay and rejects replay or expiry [H15,H17]. */
import assert from 'node:assert/strict';
import {
  randomBytes,
  webcrypto,
} from 'node:crypto';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createPairingCode,
  openPairingBundle,
  parsePairingCode,
  sealPairingBundle,
} from '../../../../packages/person/index.js';
import { decodeBoardKey } from '../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { createPairingStore } from '../../../relay/index.js';
import { createPairingHandler } from '../../../relay/index.js';
import { createRelayHandler } from '../../../relay/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { PAIR_PACKAGE_BYTES } from '../../../../packages/link/index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

const BOARD = '0123456789abcdef0123456789abcdef';
const OTHER_BOARD = 'fedcba9876543210fedcba9876543210';

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

/** Make a valid encrypted package for another board to exercise the receiver's identity guard. */
async function sealedOtherBoardPackage(code) {
  const { locator, secret } = parsePairingCode(code);
  const value = bundle({ board: OTHER_BOARD, snapshot: { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: OTHER_BOARD }], event: [{ event_id: 14 }],
  } } });
  const key = await webcrypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const aad = new TextEncoder().encode(JSON.stringify(['pullboard-pairing', 1, locator]));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext);
  return Buffer.concat([iv, Buffer.from(ciphertext)]).toString('base64url');
}

/** Read relay-owned files only; local device homes intentionally retain their own keys. */
function relayFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? relayFiles(path) : [readFileSync(path)];
  });
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
      { meta_key: 'relay_engine_version', meta_value: String(ENGINE_VERSION) },
    ],
    event: [{ event_id: 14 }],
  } } });
  assert.deepEqual(await openPairingBundle(issued.code, await sealPairingBundle(issued.code, ordered)), ordered,
    'ordered pairing binds the native checkpoint to the acknowledged relay sequence');
  const futureEngine = bundle({ mode: 'ordered', sequence: 14, snapshot: { version: 1, tables: {
    board_meta: [
      { meta_key: 'board_id', meta_value: BOARD },
      { meta_key: 'relay_applied_sequence', meta_value: '14' },
      { meta_key: 'relay_engine_version', meta_value: String(ENGINE_VERSION + 1) },
    ],
    event: [{ event_id: 14 }],
  } } });
  await assert.rejects(sealPairingBundle(issued.code, futureEngine), { code: 'PAIR_PACKAGE' },
    'pairing refuses a checkpoint from a future relay engine');

  const tampered = sealed.slice(0, -1) + (sealed.endsWith('A') ? 'B' : 'A');
  await assert.rejects(openPairingBundle(issued.code, tampered), { code: 'PAIR_CODE_INVALID' });
  const wrong = createPairingCode(BOARD);
  await assert.rejects(openPairingBundle(wrong.code, sealed), { code: 'PAIR_CODE_INVALID' });
  const wrongBoardBundle = bundle({ board: OTHER_BOARD, snapshot: { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: OTHER_BOARD }], event: [{ event_id: 14 }],
  } } });
  await assert.rejects(sealPairingBundle(issued.code, wrongBoardBundle), { code: 'PAIR_PACKAGE' },
    'the linked client will not seal a snapshot for a different board');
  await assert.rejects(openPairingBundle(issued.code, await sealedOtherBoardPackage(issued.code)), { code: 'PAIR_PACKAGE' },
    'the joining client rejects a valid encrypted package for a different board');
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
      board_meta: [{ meta_key: 'board_id', meta_value: BOARD }, { meta_key: 'relay_applied_sequence', meta_value: '14' }, { meta_key: 'relay_engine_version', meta_value: String(ENGINE_VERSION) }],
      event: [{ event_id: 13 }],
    } } }),
  ]) {
    await assert.rejects(sealPairingBundle(code, invalid), { code: 'PAIR_PACKAGE' });
  }
  const oversized = bundle({ snapshot: { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: BOARD }], event: [{ event_id: 14 }], marker: [{ value: 'x'.repeat(PAIR_PACKAGE_BYTES + 1) }],
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

test('[H15,H17] a pairing code cannot be consumed as another board', () => {
  const store = createPairingStore();
  const issued = createPairingCode(BOARD);
  const opaque = 'A'.repeat(60);
  store.publish(BOARD, issued.locator, opaque);

  assert.throws(() => store.consume(OTHER_BOARD, issued.locator), { code: 'PAIR_CODE_INVALID' },
    'the relay record is bound to the board that published the code');
  assert.deepEqual(store.consume(BOARD, issued.locator), { sealed: opaque },
    'a mismatched-board attempt does not spend the original code');
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
  const larger = bundle({ snapshot: { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: BOARD }], event: [{ event_id: 14 }], marker: [{ value: 'x'.repeat(20_000_000) }],
  } } });
  const sealed = await sealPairingBundle(issued.code, larger);
  assert.ok(Buffer.byteLength(JSON.stringify({ sealed })) > 20_000_000, 'the encrypted package exceeds the former HTTP body bound');
  assert.ok(Buffer.byteLength(sealed, 'base64url') > 19_000_000, 'the decoded package exceeds the former envelope bound');
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
  assert.deepEqual(await openPairingBundle(issued.code, response.sealed), larger,
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
    minimumEngineVersion() { return 1; },
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
  await box.requireEngineThree();
  const linkedSource = await box.cli('export');
  assert.equal(linkedSource.code, 0, 'the linked source exports its current checkpoint');
  const printed = await box.cli('relay', 'pair');
  assert.equal(printed.code, 0, 'the linked CLI publishes a one-use pairing envelope');
  assert.match(printed.document.code, /^[0-9a-f]{32}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(printed.document.expiresIn, 600);
  assert.ok(printed.document.link.startsWith(box.origin + '/#board='), 'the phone link uses the relay this board is linked to');
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const { locator } = parsePairingCode(printed.document.code);
  const staleClient = await fetch(box.origin + '/api/v1/pairings/' + state.board + '/' + locator + '/consume', {
    method: 'POST', headers: { authorization: 'Bearer ' + state.token, 'x-pullboard-engine': '1' },
  });
  assert.equal(staleClient.status, 400, 'an obsolete engine cannot consume the one-use envelope');
  assert.equal((await staleClient.json()).error.code, 'ENGINE_VERSION');
  const paired = await box.otherDeviceJoin(printed.document.code);
  assert.equal(paired.joined.board, box.before.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value);
  assert.deepEqual(paired.exported, linkedSource.document, 'the second clone imports the source checkpoint and counters after linking');
  assert.ok(!box.calls.some((call) => call.path.includes(printed.document.code)), 'the code secret never appears in a relay request path');
});

test('[H15,H17] a paired clone synchronizes without a key file from PULLBOARD_RELAY_KEY', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const printed = await box.cli('relay', 'pair');
  const paired = await box.otherDeviceJoin(printed.document.code);
  const beforeSyncCalls = box.calls.length;
  const synchronized = await paired.syncWithEnvironmentKey('export');
  assert.equal(synchronized.code, 0, 'the paired clone reads the relay using its local environment key');
  assert.equal(paired.keyFileExists(), false, 'the synchronization ran with no stored key file');
  assert.ok(box.calls.slice(beforeSyncCalls).some(({ method, path }) => method === 'GET' && /\/events\?after=/.test(path)),
    'the clone fetched linked relay state with no stored key file');
  assert.deepEqual(synchronized.document, paired.exported, 'sync reads the paired board without changing its native rows');

  const encodedKey = readFileSync(box.keyFile, 'utf8').trim();
  const keyBytes = decodeBoardKey(encodedKey);
  const secretText = printed.document.code.split('.')[2];
  const secretBytes = parsePairingCode(printed.document.code).secret;
  const wireBytes = Buffer.concat(box.transit.flatMap(({ request, response }) => [request, response]));
  const relayDiskBytes = Buffer.concat([...relayFiles(box.relayDirectory), readFileSync(box.authDatabase)]);
  const output = JSON.stringify(synchronized.document);
  for (const [label, value] of [
    ['raw board key bytes', keyBytes],
    ['encoded board key', Buffer.from(encodedKey)],
    ['raw pairing secret bytes', Buffer.from(secretBytes)],
    ['encoded pairing secret', Buffer.from(secretText)],
  ]) {
    assert.equal(wireBytes.includes(value), false, `relay HTTP bodies contain no ${label}`);
    assert.equal(relayDiskBytes.includes(value), false, `relay-owned files contain no ${label}`);
  }
  assert.equal(box.calls.some(({ path }) => path.includes(secretText)), false, 'the pairing secret never appears in a relay URL');
  assert.equal(output.includes(encodedKey), false, 'the environment key is not echoed in the clone command result');
  assert.equal(output.includes(secretText), false, 'the pairing secret is not echoed in the clone command result');
});

test('pairing again after a device joined and a move was added succeeds [H15,H17,H16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const first = await box.cli('relay', 'pair');
  assert.equal(first.code, 0, 'the unchanged linked board can issue a pairing package');
  const joined = await box.otherDeviceJoin(first.document.code);
  assert.equal(joined.joined.board, box.before.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value,
    'the baseline one-use package is consumed by a genuine second private native device');
  const added = await box.cli('add', box.lane, 'An acknowledged move before pairing', '--criterion', 'The next device can join');
  assert.equal(added.code, 0, JSON.stringify(added.document));
  const snapshot = await box.cli('export');
  assert.equal(snapshot.code, 0);
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const meta = new Map(snapshot.document.tables.board_meta.map(row => [row.meta_key, row.meta_value]));
  assert.equal(state.mode, 'ordered');
  assert.equal(state.sequence, Number(meta.get('relay_applied_sequence')), 'the real sync has acknowledged this native prefix');
  const nativeCursor = snapshot.document.tables.event.at(-1)?.event_id ?? 0;
  const second = await box.cli('relay', 'pair');
  assert.equal(second.code, 0, 'an acknowledged board must pair after ordinary moves: ' + JSON.stringify({
    error: second.document.error, savedNativeCursor: state.cursor, actualNativeCursor: nativeCursor,
    relaySequence: state.sequence, appliedSequence: Number(meta.get('relay_applied_sequence')),
  }));
});

test('a newly paired device imports the acknowledged moved board [H15,H17,H16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const added = await box.cli('add', box.lane, 'The next computer sees this acknowledged move', '--criterion', 'The native checkpoint and move agree');
  assert.equal(added.code, 0);
  const current = await box.cli('export');
  assert.equal(current.code, 0);
  const printed = await box.cli('relay', 'pair');
  assert.equal(printed.code, 0, JSON.stringify(printed.document.error));
  const paired = await box.otherDeviceJoin(printed.document.code);
  assert.deepEqual(paired.exported, current.document, 'a real independent native join imports the complete moved checkpoint');
  assert.equal(paired.exported.tables.item.some(row => row.item_title === 'The next computer sees this acknowledged move'), true);
});


test('a move made during pairing is still refused as busy [H15,H17]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const result = await box.script(`
    const store = await import(${JSON.stringify(new URL('../../../../packages/store/index.js', import.meta.url).href)});
    const { openBoard } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const {relayPair} = await import(${JSON.stringify(new URL('../../../../packages/keys/index.js', import.meta.url).href)});
    const pairPorts = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
    const root = process.cwd();
    const originalFetch = globalThis.fetch;
    let injected = false;
    globalThis.fetch = async (...args) => {
      if (!injected && String(args[0]).includes('/events?after=')) {
        injected = true;
        const board = openBoard(root + '/.git/pullboard/board.sqlite');
        try { store.addItem(board, {by:'coordinator',lane:${JSON.stringify(box.lane)},title:'A real local move during pairing',criterion:'The pending pairing must refuse'}); }
        finally { store.closeBoard(board); }
      }
      return originalFetch(...args);
    };
    const sink = {isTTY:false,write(){}};
    let code = null, issued = false;
    try { await relayPair(root,{...(await import(${JSON.stringify(new URL('../../tests/fixtures/board.js', import.meta.url).href)})).apiBoardOpeners,cwd:root,stdout:sink,stderr:sink,say(){},err(){},result(){issued=true;}},{...pairPorts,openBoard}); }
    catch(error) { code=error.code; }
    finally { globalThis.fetch=originalFetch; }
    process.stdout.write(JSON.stringify({injected,code,issued}));
  `);
  assert.equal(result.code,0,result.stderr);
  assert.equal(result.document.injected,true,'the real local store move occurred while the pairing sync awaited actual HTTP');
  assert.equal(result.document.code,'PAIR_BUSY','pairing must refuse a native move during its async sync: '+JSON.stringify(result.document));
  assert.equal(result.document.issued,false,'a changed native prefix never prints a usable pairing code');
});


test('a local move during pairing upload refuses before issuing a code [H15,H17]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const result = await box.script(`
    const store = await import(${JSON.stringify(new URL('../../../../packages/store/index.js', import.meta.url).href)});
    const { openBoard } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const {relayPair} = await import(${JSON.stringify(new URL('../../../../packages/keys/index.js', import.meta.url).href)});
    const pairPorts = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
    const root = process.cwd();
    const originalFetch = globalThis.fetch;
    let injected = false;
    globalThis.fetch = async (...args) => {
      if (!injected && String(args[0]).includes('/api/v1/pairings/')) {
        injected = true;
        const board = openBoard(root + '/.git/pullboard/board.sqlite');
        try { store.addItem(board, {by:'coordinator',lane:${JSON.stringify(box.lane)},title:'A real local move during pairing upload',criterion:'Pairing must retry the changed native boundary'}); }
        finally { store.closeBoard(board); }
      }
      return originalFetch(...args);
    };
    const sink = {isTTY:false,write(){}};
    let code = null, issued = false;
    try { await relayPair(root,{...(await import(${JSON.stringify(new URL('../../tests/fixtures/board.js', import.meta.url).href)})).apiBoardOpeners,cwd:root,stdout:sink,stderr:sink,say(){},err(){},result(){issued=true;}},{...pairPorts,openBoard}); }
    catch(error) { code=error.code; }
    finally { globalThis.fetch=originalFetch; }
    process.stdout.write(JSON.stringify({injected,code,issued}));
  `);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.document.injected, true, 'the actual native move occurred during pairing upload');
  assert.equal(result.document.code, 'PAIR_BUSY', 'the pairing upload must reject its changed native boundary: '+JSON.stringify(result.document));
  assert.equal(result.document.issued, false, 'a changed native boundary must not print the one-use code');
});


test('a refused upload race discards only its unprinted package [H15,H17]', async t => {
  const box=await relayClientFixture(t);
  await box.link();
  const result=await box.script(`
    const store=await import(${JSON.stringify(new URL('../../../../packages/store/index.js',import.meta.url).href)});
    const { openBoard } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const {relayPair}=await import(${JSON.stringify(new URL('../../../../packages/keys/index.js',import.meta.url).href)});
    const pairPorts = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
    const root=process.cwd(), originalFetch=globalThis.fetch;
    let injected=false,published=null;
    globalThis.fetch=async (...args)=>{
      const url=String(args[0]);
      if(!injected && url.includes('/api/v1/pairings/') && !url.endsWith('/consume')) {
        injected=true;published=url;
        const board=openBoard(root+'/.git/pullboard/board.sqlite');
        try{store.addItem(board,{by:'coordinator',lane:${JSON.stringify(box.lane)},title:'Late private local move',criterion:'Discard its unpublished package'});}finally{store.closeBoard(board);}
      }
      return originalFetch(...args);
    };
    const sink={isTTY:false,write(){}};let code=null,issued=false;
    try{await relayPair(root,{...(await import(${JSON.stringify(new URL('../../tests/fixtures/board.js', import.meta.url).href)})).apiBoardOpeners,cwd:root,stdout:sink,stderr:sink,say(){},err(){},result(){issued=true;}},{...pairPorts,openBoard});}catch(error){code=error.code;}finally{globalThis.fetch=originalFetch;}
    const {readFileSync}=await import('node:fs');
    const state=JSON.parse(readFileSync(root+'/.git/pullboard/relay.json','utf8'));
    const second=await originalFetch(published+'/consume',{method:'POST',headers:{authorization:'Bearer '+state.token,'content-type':'application/json','x-pullboard-engine':${JSON.stringify(String(ENGINE_VERSION))}},body:'{}'});
    process.stdout.write(JSON.stringify({code,issued,discarded:(await second.json()).error?.code}));
  `);
  assert.equal(result.code,0,result.stderr);
  assert.deepEqual(result.document,{code:'PAIR_BUSY',issued:false,discarded:'PAIR_CODE_USED'},'the stale, unprinted package has already been consumed');
  const retried=await box.cli('relay', 'pair');
  assert.equal(retried.code,0,JSON.stringify(retried.document.error));
  const joined=await box.otherDeviceJoin(retried.document.code);
  assert.ok(joined.exported.tables.item.some(row=>row.item_title==='Late private local move'),'the next fresh pairing imports the current native board');
});


test('a local move while sealing is refused before the pairing upload [H15,H17]', async t => {
  const box=await relayClientFixture(t);
  await box.link();
  const result=await box.script(`
    const {webcrypto}=await import('node:crypto');
    const store=await import(${JSON.stringify(new URL('../../../../packages/store/index.js',import.meta.url).href)});
    const { openBoard } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const {relayPair}=await import(${JSON.stringify(new URL('../../../../packages/keys/index.js',import.meta.url).href)});
    const pairPorts = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
    const root=process.cwd(), originalEncrypt=webcrypto.subtle.encrypt;
    let injected=false,issued=false,code=null;
    webcrypto.subtle.encrypt=async function(...args) {
      const result=await originalEncrypt.apply(this,args);
      const aad=new TextDecoder().decode(args[0].additionalData??new Uint8Array());
      if(!injected && aad.startsWith('["pullboard-pairing",')) {
        injected=true;
        const board=openBoard(root+'/.git/pullboard/board.sqlite');
        try{store.addItem(board,{by:'coordinator',lane:${JSON.stringify(box.lane)},title:'A native move while the package is sealing',criterion:'No stale package is uploaded'});}finally{store.closeBoard(board);}
      }
      return result;
    };
    const sink={isTTY:false,write(){}};
    try{await relayPair(root,{...(await import(${JSON.stringify(new URL('../../tests/fixtures/board.js', import.meta.url).href)})).apiBoardOpeners,cwd:root,stdout:sink,stderr:sink,say(){},err(){},result(){issued=true;}},{...pairPorts,openBoard});}catch(error){code=error.code;}finally{webcrypto.subtle.encrypt=originalEncrypt;}
    process.stdout.write(JSON.stringify({injected,code,issued}));
  `);
  assert.equal(result.code,0,result.stderr);
  assert.deepEqual(result.document,{injected:true,code:'PAIR_BUSY',issued:false});
  assert.equal(box.calls.some(call=>call.path.startsWith('/api/v1/pairings/')),false,'a stale package is refused before its first publish request');
});
