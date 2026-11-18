/** Pairing HTTP, relay service bounds and the real second clone keep one-time pairing safe [H15,H17]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPairingCode } from '../../../../packages/person/index.js';
import { openPairingBundle } from '../../../../packages/person/index.js';
import { parsePairingCode } from '../../../../packages/person/index.js';
import { sealPairingBundle } from '../../../../packages/person/index.js';
import { decodeBoardKey } from '../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { createPairingStore } from '../../../relay/index.js';
import { createPairingHandler } from '../../../relay/index.js';
import { createRelayHandler } from '../../../relay/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

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

/** Read relay-owned files only; local device homes intentionally retain their own keys. */
function relayFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? relayFiles(path) : [readFileSync(path)];
  });
}

test('cli.journeys-relay-pairing-part2.pairing-http-authenticates-repository-access-before: [H15,H17] pairing HTTP authenticates repository access before publishing or consuming', async (t) => {
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

test('cli.journeys-relay-pairing-part2.relay-service-holds-only-bounded-opaque: [H15,H17] relay service holds only bounded opaque pairing bytes and preserves its existing board files', async (t) => {
  const { root } = privateFixtureFiles('pullboard-pair-service-');
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

test('cli.journeys-relay-pairing-part2.production-cli-pairs-a-real-second: [H15,H17] production CLI pairs a real second clone and reads the same board', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  await box.requireEngineThree();
  const linkedSource = await box.cliLocal('export');
  assert.equal(linkedSource.code, 0, 'the linked source exports its current checkpoint');
  const printed = await box.cliLocal('relay', 'pair');
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

test('cli.journeys-relay-pairing-part2.a-paired-clone-synchronizes-without-a: [H15,H17] a paired clone synchronizes without a key file from PULLBOARD_RELAY_KEY', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const printed = await box.cliLocal('relay', 'pair');
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
