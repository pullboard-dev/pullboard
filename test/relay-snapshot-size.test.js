/** Compression stays inside the device seal while both clients retain legacy snapshot reads [H5,H15,H17]. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { decodeBoardKey, seal, unseal } from '../src/seal.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { presentationDigest, relaySnapshot } from '../src/relay-presentation.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';

const RELAY_LIMIT = 10_000_000;
const BODY_LIMIT = 14_000_000;

/** Preserve every SQLite value while normalizing row prototypes for JSON transport comparisons. */
function plainRows(rows) { return rows.map(row => ({ ...row })); }

/** Normalize all exported tables without dropping columns or changing their order. */
function plainTables(tables) { return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, plainRows(rows)])); }

/** Run a real CLI text command inside the fixture process and return only its captured streams. */
async function textCommand(box, ...args) {
  const source = `
    import { main } from ${JSON.stringify(box.mainURL)};
    let stdout = '', stderr = '';
    const code = await main(${JSON.stringify(args)}, {
      cwd: process.cwd(),
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } },
    });
    console.log(JSON.stringify({ code, stdout, stderr }));
  `;
  return (await box.script(source)).document;
}

/** Seal a legacy plaintext snapshot at its current authenticated relay position. */
async function sealedSnapshot(box, document, sequence, compressed) {
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const json = Buffer.from(JSON.stringify(document));
  const plaintext = compressed ? gzipSync(json) : json;
  return Buffer.from(await seal(key, plaintext, { boardId: state.board, kind: 'snapshot', sequence })).toString('base64url');
}

test('a large board syncs to the relay compressed [H5,H15,H17]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  await box.link();

  // Pair a second native CLI while the board is small; it must later restore the relay snapshot.
  const pairing = await box.cli('relay', 'pair');
  const second = await box.otherDeviceJoin(pairing.document.code);

  // An ordinary older JSON snapshot remains readable by the CLI after the relay compacts it.
  assert.equal((await box.cli('add', box.lane, 'legacy snapshot cursor')).code, 0);
  let sourceState = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  let legacyDocument = relaySnapshot(box.root);
  const legacySealed = await sealedSnapshot(box, legacyDocument, sourceState.sequence, false);
  const legacyUpload = await fetch(box.origin + '/api/v1/boards/' + sourceState.board + '/state', {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + sourceState.token, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: sourceState.sequence, sealed: legacySealed }),
  });
  assert.equal(legacyUpload.status, 200, 'the relay continues accepting a stored legacy JSON snapshot');
  const legacyRead = await second.cli('status');
  assert.equal(legacyRead.code, 0, legacyRead.document?.error?.message);
  const legacyExport = await second.cli('export');
  assert.equal(legacyExport.code, 0);
  assert.deepEqual(plainRows(legacyExport.document.tables.item), plainRows(legacyDocument.tables.item), 'the CLI restored the legacy JSON snapshot from the relay');

  // The second CLI publishes its own current gzip checkpoint after restoring; replace it with the same legacy bytes before the browser reads.
  const browserLegacyUpload = await fetch(box.origin + '/api/v1/boards/' + sourceState.board + '/state', {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + sourceState.token, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: sourceState.sequence, sealed: legacySealed }),
  });
  assert.equal(browserLegacyUpload.status, 200);
  assert.equal((await browserLegacyUpload.json()).state.sealed, legacySealed, 'the browser starts with the exact stored uncompressed bytes');

  // The actual browser keeps reading a previously stored uncompressed JSON checkpoint too.
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Network.setCookie', {
    name: 'pb_session', value: sourceState.token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  const encodedKey = readFileSync(box.keyFile, 'utf8').trim();
  await chrome.navigate(box.origin + '/#board=' + sourceState.board + '&key=' + encodedKey);
  try {
    await chrome.waitFor("document.querySelector('#chain')?.textContent.includes('legacy snapshot cursor')");
  } catch (error) {
    t.diagnostic('legacy browser read: ' + JSON.stringify(await chrome.evaluate("({ title: document.title, notice: document.querySelector('#relay-notice')?.textContent.slice(0, 800), signIn: document.body.textContent.includes('Sign in with GitHub'), hasLegacy: document.body.textContent.includes('legacy snapshot cursor') })")));
    throw error;
  }
  t.diagnostic('legacy browser snapshot read passed');

  const marker = 'COMPRESSED_RELAY_SNAPSHOT_EXACT_340_';
  const longText = marker + 'q'.repeat(7_200_000);
  const native = store.openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    store.shout(native, { from: 'coordinator', to: 'all', text: longText, lanes: [box.lane] });
    // The historical payload grows the native snapshot without sending a seven-megabyte paragraph to the recent UI feed.
    for (let index = 0; index < 100; index++) {
      store.shout(native, { from: 'coordinator', to: 'all', text: marker + 'recent ' + index, lanes: [box.lane] });
    }
  } finally { store.closeBoard(native); }
  const before = relaySnapshot(box.root);
  assert.ok(Buffer.byteLength(JSON.stringify(before)) > BODY_LIMIT, 'the uncompressed snapshot exceeds the unchanged relay body limit');
  const uncompressedSealed = await sealedSnapshot(box, before, JSON.parse(readFileSync(box.linkFile, 'utf8')).sequence, false);
  assert.ok(Buffer.from(uncompressedSealed, 'base64url').byteLength > BODY_LIMIT, 'the actual legacy sealed snapshot exceeds the relay body limit before base64 framing');

  assert.equal((await box.cli('status')).code, 0, 'the local CLI publishes a compressed pending snapshot');
  assert.equal((await box.cli('add', box.lane, 'advance compressed snapshot')).code, 0, 'an acknowledged move advances the relay snapshot cursor');
  const expected = relaySnapshot(box.root);
  const snapshotRequest = box.transit.filter(row => row.method === 'PUT' && row.path.endsWith('/state')).at(-1);
  assert.ok(snapshotRequest, 'the actual linked CLI uploaded a snapshot to the relay');
  const uploadBody = JSON.parse(snapshotRequest.request.toString('utf8'));
  const sealedBytes = Buffer.from(uploadBody.sealed, 'base64url');
  assert.ok(sealedBytes.byteLength < RELAY_LIMIT, 'the opaque compressed snapshot fits the decoded journal limit');
  assert.ok(snapshotRequest.request.byteLength < BODY_LIMIT, 'the base64 transport body fits the unchanged request limit');
  const boardKey = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const plaintext = await unseal(boardKey, sealedBytes, { boardId: JSON.parse(readFileSync(box.linkFile, 'utf8')).board, kind: 'snapshot', sequence: uploadBody.sequence });
  assert.deepEqual(plainTables(JSON.parse(gunzipSync(plaintext).toString('utf8')).tables), plainTables(expected.tables),
    'the gzip payload inside the device seal is the exact native snapshot');
  assert.equal(snapshotRequest.request.includes(Buffer.from(marker)), false, 'the relay request contains no board plaintext');
  assert.equal(snapshotRequest.response.includes(Buffer.from(marker)), false, 'the relay response contains no board plaintext');

  // A second CLI that predates this checkpoint must restore the compressed snapshot exactly.
  assert.equal((await second.cli('status')).code, 0, 'the paired CLI restores the compressed snapshot');
  const restored = await second.cli('export');
  assert.equal(restored.code, 0);
  assert.deepEqual(plainTables(restored.document.tables), plainTables(expected.tables), 'the paired CLI reads back the exact compressed snapshot');

  // The actual Chrome client reads that same compressed checkpoint and renders the full shout text.
  sourceState = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  await chrome.navigate(box.origin);
  try {
    await chrome.waitFor("document.querySelector('#feed')?.textContent.includes(" + JSON.stringify(marker) + ") || document.querySelector('#relay-notice')?.textContent.includes('Could not open this board with its saved key')");
  } catch (error) {
    t.diagnostic('compressed browser read: ' + JSON.stringify(await chrome.evaluate("({ title: document.title, notice: document.querySelector('#relay-notice')?.textContent.slice(0, 800), signIn: document.body.textContent.includes('Sign in with GitHub'), hasMarker: document.body.textContent.includes('COMPRESSED_RELAY_SNAPSHOT_EXACT_340_') })")));
    throw error;
  }
  assert.equal(await chrome.evaluate("document.querySelector('#feed')?.textContent.includes(" + JSON.stringify(marker) + ') ?? false'), true, 'the production browser decoder reads the compressed checkpoint');
  const projection = { ...expected.presentation.state, root: sourceState.board };
  const projectionHash = createHash('sha256').update(JSON.stringify(projection)).digest('hex');
  const tablesHash = createHash('sha256').update(JSON.stringify(expected.tables)).digest('hex');
  const browserRead = await chrome.evaluate(`(async () => {
    const { createTransport } = await import('/relay/client.js');
    const transport = await createTransport();
    const document = await transport.request('/api/v1/boards/${sourceState.board}/state');
    const { decodeBoardKey, unseal } = await import('/relay/seal.js');
    const response = await fetch('/api/v1/boards/${sourceState.board}/state', { headers: { 'x-pullboard-engine': '${ENGINE_VERSION}' } });
    const envelope = (await response.json()).state;
    const encoded = envelope.sealed.replaceAll('-', '+').replaceAll('_', '/');
    const ciphertext = Uint8Array.from(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)), value => value.charCodeAt(0));
    const keys = JSON.parse(localStorage.getItem('pullboard.relay.keys.v1'));
    const plain = await unseal(decodeBoardKey(keys['${sourceState.board}']), ciphertext, { boardId: '${sourceState.board}', kind: 'snapshot', sequence: envelope.sequence });
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
    const native = JSON.parse(await new Response(stream).text());
    /** Hash exact browser-decoded JSON without sending private contents into test diagnostics. */
    async function digest(value) {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
      return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    }
    return { projectionHash: await digest(document.state), tablesHash: await digest(native.tables) };
  })()`, 'hash browser projection and native snapshot');
  assert.deepEqual(browserRead, { projectionHash, tablesHash }, 'the production browser client reads the exact projection and browser gzip retains every native table byte');

  // A valid but still-too-large gzip checkpoint remains pending and is named by both CLI readers.
  const oversizedDocument = relaySnapshot(box.root);
  const randomTitle = 'OVERSIZE_SNAPSHOT_340_' + randomBytes(5_050_000).toString('base64');
  const itemId = oversizedDocument.tables.item[0].item_id;
  oversizedDocument.tables.item.find(row => row.item_id === itemId).item_title = randomTitle;
  oversizedDocument.presentation.state.items.find(row => row.id === itemId).title = randomTitle;
  const oversizedGzip = await sealedSnapshot(box, oversizedDocument, sourceState.sequence, true);
  const oversizedBytes = Buffer.from(oversizedGzip, 'base64url').byteLength;
  assert.ok(oversizedBytes > RELAY_LIMIT, 'the compressed sealed snapshot still exceeds the relay journal limit');
  assert.ok(Buffer.byteLength(JSON.stringify({ sequence: sourceState.sequence, sealed: oversizedGzip })) < BODY_LIMIT,
    'the oversized sealed snapshot remains below the unchanged HTTP body limit');
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const localDigest = presentationDigest(relaySnapshot(box.root).presentation);
  link.checkpoint = { sequence: sourceState.sequence, sealed: oversizedGzip };
  link.checkpointPresentationDigest = localDigest;
  writeFileSync(box.linkFile, JSON.stringify(link), { mode: 0o600 });

  const status = await textCommand(box, 'status');
  assert.match(status.stdout, new RegExp(`relay snapshot for ${sourceState.board}: sealed snapshot \\d+\\.\\d MB over the relay limit 10\\.0 MB`));
  const doctor = await textCommand(box, 'doctor');
  assert.equal(doctor.code, 1);
  const doctorJSON = await box.cli('doctor');
  assert.equal(doctorJSON.code, 1);
  assert.ok(doctorJSON.document.problems.some(problem => problem.code === 'RELAY_SNAPSHOT_LIMIT'), 'doctor JSON names the stable oversize rule');
  assert.match(doctor.stdout, new RegExp(`relay snapshot for ${sourceState.board}: sealed snapshot \\d+\\.\\d MB over the relay limit 10\\.0 MB`));
});
