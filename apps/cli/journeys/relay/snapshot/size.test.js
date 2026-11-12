// pullboard: browser
/** @pullboard-test-gui */
/** Compression stays inside the device seal while both clients retain legacy snapshot reads [H5,H15,H17]. */
import {
  nativeBoardPorts as relayPresentationNativePorts,
  openBoard,
} from '../../../../lib/index.js';
import assert from 'node:assert/strict';
import {
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  gzipSync,
  gunzipSync,
} from 'node:zlib';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  decodeBoardKey,
  seal,
  unseal,
} from '../../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import {
  SEALED_SNAPSHOT_BYTES as RELAY_LIMIT,
  SNAPSHOT_BODY_BYTES as BODY_LIMIT,
} from '../../../../../packages/link/index.js';
import {
  presentationDigest,
  relaySnapshot,
} from '../../../../../packages/pages/index.js';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import {
  beforeShoutLimit,
  pagedReadContext,
  plainRows,
  plainTables,
} from '../../../tests/fixtures/relay/sealed-client.js';
import {
  findChromeExecutable,
  startChrome,
} from '../../../tests/fixtures/relay/browser.js';
import { readSealedDescriptor } from '../../../../../packages/pages/index.js';
import { openPagedSnapshot } from '../../../../../packages/pages/index.js';
import { stableChrome } from '../../../tests/fixtures/cockpit/stable.js';
/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;
const LEGACY_BODY_THRESHOLD = 14_000_000;
const LEGACY_RELAY_THRESHOLD = 10_000_000;
const SIGNED_IN_BOARD_RENDER_WAIT_MS = 15_000;

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

test('a 20 MB sealed snapshot syncs to the relay and reads back whole [H5,H15,H17]', { timeout: 180_000 }, async t => {
  const box = await relayClientFixture(t);
  box.legacySnapshotApi(); // Exercise the legacy whole-snapshot endpoint.
  await box.link();
  const local = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    beforeShoutLimit(local, () => store.shout(local, { from: 'coordinator', to: 'all', text: 'LARGE_SEALED_SNAPSHOT_' + randomBytes(14_000_000).toString('base64url'), lanes: [box.lane] }));
    assert.throws(() => store.shout(local, { from: 'coordinator', to: 'all', text: 'q'.repeat(401), lanes: [box.lane] }),
      { code: 'SHOUT_TOO_LONG' }, 'a new shout at the current engine is still held to 400 characters');
  } finally { store.closeBoard(local); }

  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const sealed = await sealedSnapshot(box, relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS), state.sequence, true);
  const sealedBytes = Buffer.from(sealed, 'base64url');
  assert.ok(sealedBytes.byteLength > 20_000_000, 'the gzip snapshot exceeds 20,000,000 decoded bytes');
  assert.ok(sealedBytes.byteLength < RELAY_LIMIT, 'the gzip snapshot remains within the shared decoded limit');
  const requestBody = JSON.stringify({ sequence: state.sequence, sealed });
  assert.ok(Buffer.byteLength(requestBody) < BODY_LIMIT, 'the base64 request fits the shared HTTP body limit');

  const path = box.origin + '/api/v1/boards/' + state.board + '/state';
  const headers = { authorization: 'Bearer ' + state.token, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' };
  const upload = await fetch(path, { method: 'PUT', headers, body: requestBody });
  const accepted = await upload.json();
  assert.equal(upload.status, 200, 'the real local relay accepts the >20 MB sealed snapshot: ' + JSON.stringify(accepted));
  assert.equal(accepted.state.sealed, sealed, 'the accepted response preserves every sealed byte');

  const read = await fetch(path, { headers: { authorization: headers.authorization, 'x-pullboard-engine': headers['x-pullboard-engine'] } });
  assert.equal(read.status, 200, 'the real local relay serves the stored large snapshot');
  const returned = await read.json();
  assert.equal(returned.state.sealed, sealed, 'a readback returns the exact sealed snapshot bytes');
  assert.deepEqual(Buffer.from(returned.state.sealed, 'base64url'), sealedBytes);
});

test('a large board syncs to the relay compressed [H5,H15,H17]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  box.legacySnapshotApi(); // This case explicitly preserves an older relay's whole-snapshot interface.
  await box.link();

  // Pair a second native CLI while the board is small; it must later restore the relay snapshot.
  const pairing = await box.cliLocal('relay', 'pair');
  const second = await box.otherDeviceJoin(pairing.document.code);

  // An ordinary older JSON snapshot remains readable by the CLI after the relay compacts it.
  assert.equal((await box.cliLocal('add', box.lane, 'legacy snapshot cursor')).code, 0);
  let sourceState = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  let legacyDocument = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
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
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  const phone = await box.phoneSession();
  const cookie = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: phone.token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(cookie.success, true, 'Chrome accepted the signed-in phone session cookie');
  const encodedKey = readFileSync(box.keyFile, 'utf8').trim();
  await chrome.navigate(box.origin + '/#board=' + sourceState.board + '&key=' + encodedKey);
  await chrome.waitFor('location.origin === ' + JSON.stringify(box.origin) + ' && document.readyState === "complete"');
  const inventory = await chrome.stable(`(async () => {
    const response = await fetch('/api/v1/boards', { credentials: 'same-origin' });
    let value = null; try { value = await response.json(); } catch {}
    return { status: response.status, boardIds: (value?.boards ?? []).map(board => board.id), error: value?.error?.code ?? null };
  })()`);
  assert.equal(inventory.status, 200, `the signed-in page reads its relay inventory: ${JSON.stringify(inventory)}`);
  assert.ok(inventory.boardIds.includes(sourceState.board), `the browser account can see this linked board: ${JSON.stringify(inventory)}`);
  assert.deepEqual(await chrome.stable(`(async () => {
    const { Refused } = await import('/relay/refused.js');
    const refusal = new Refused('BROWSER_CONTROL', 'module loaded', 'recover here');
    return { name: refusal.name, code: refusal.code, message: refusal.message, next: refusal.next };
  })()`), { name: 'Refused', code: 'BROWSER_CONTROL', message: '[BROWSER_CONTROL] module loaded', next: 'recover here' },
  'the actual served refusal module loads its complete browser dependency graph and retains its constructor contract');
  try {
    await chrome.waitFor( // budget: bounded 15 s fixture page-state handshake hang ceiling.
      `typeof data !== 'undefined' && data.project?.items?.some(item => item.title === 'legacy snapshot cursor')`, SIGNED_IN_BOARD_RENDER_WAIT_MS,
      'the signed-in page has loaded the legacy snapshot item');
  } catch (error) {
    t.diagnostic('signed-in relay board read: ' + JSON.stringify(await chrome.stable(`(() => ({
      activeTab: typeof view !== 'undefined' ? view.tab : null,
      itemTitles: typeof data !== 'undefined' && Array.isArray(data?.project?.items) ? data.project.items.slice(0, 5).map(item => item.title) : [],
      notice: document.querySelector('#relay-notice')?.textContent.slice(0, 800),
    }))()`)));
    throw error;
  }
  await chrome.click(`document.querySelector('[data-tab="items"]')`);
  assert.equal(await chrome.stable(`document.querySelector('[data-tab="items"]')?.classList.contains('on')`), true,
  'the browser shows the Items tab before checking its chain');
  try {
    await chrome.waitFor("document.querySelector('#chain')?.textContent.includes('legacy snapshot cursor')");
  } catch (error) {
    t.diagnostic('legacy browser read: ' + JSON.stringify(await chrome.stable(`(() => ({
      title: document.title,
      notice: document.querySelector('#relay-notice')?.textContent.slice(0, 800),
      activeTab: typeof view !== 'undefined' ? view.tab : null,
      hasLegacy: document.body.textContent.includes('legacy snapshot cursor'),
      chainText: document.querySelector('#chain')?.textContent.slice(0, 240) ?? null,
    }))()`)));
    throw error;
  }
  t.diagnostic('legacy browser snapshot read passed');

  const marker = 'COMPRESSED_RELAY_SNAPSHOT_EXACT_340_';
  const longText = marker + 'q'.repeat(7_200_000);
  const native = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    beforeShoutLimit(native, () => store.shout(native, { from: 'coordinator', to: 'all', text: longText, lanes: [box.lane] }));
    // The historical payload grows the native snapshot without sending a seven-megabyte paragraph to the recent UI feed.
    for (let index = 0; index < 100; index++) {
      store.shout(native, { from: 'coordinator', to: 'all', text: marker + 'recent ' + index, lanes: [box.lane] });
    }
  } finally { store.closeBoard(native); }
  const before = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
  assert.ok(Buffer.byteLength(JSON.stringify(before)) > LEGACY_BODY_THRESHOLD, 'the legacy uncompressed snapshot exceeds the former body bound');
  const uncompressedSealed = await sealedSnapshot(box, before, JSON.parse(readFileSync(box.linkFile, 'utf8')).sequence, false);
  assert.ok(Buffer.from(uncompressedSealed, 'base64url').byteLength > LEGACY_BODY_THRESHOLD, 'the uncompressed legacy seal exceeds the former body bound');

  assert.equal((await box.cli('status')).code, 0, 'the local CLI publishes a compressed pending snapshot');
  assert.equal((await box.cliLocal('add', box.lane, 'advance compressed snapshot')).code, 0, 'an acknowledged move advances the relay snapshot cursor');
  assert.equal((await box.cli('status')).code, 0, 'the local CLI publishes the advanced compressed checkpoint');
  const expected = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
  const snapshotRequest = box.transit.filter(row => row.method === 'PUT' && row.path.endsWith('/state')).at(-1);
  assert.ok(snapshotRequest, 'the actual linked CLI uploaded a snapshot to the relay');
  const uploadBody = JSON.parse(snapshotRequest.request.toString('utf8'));
  const sealedBytes = Buffer.from(uploadBody.sealed, 'base64url');
  assert.ok(sealedBytes.byteLength < RELAY_LIMIT, 'the opaque compressed snapshot fits the decoded journal limit');
  assert.ok(snapshotRequest.request.byteLength < BODY_LIMIT, 'the base64 transport body fits the shared request limit');
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
  const previousDocument = await chrome.stable('performance.timeOrigin');
  await chrome.navigate(box.origin);
  // The feed renders when its native tab is selected, rather than while Items is open.
  await chrome.waitFor('performance.timeOrigin !== ' + JSON.stringify(previousDocument)
    + ' && document.readyState === "complete" && typeof data === "object" && !!data?.project && addressReady'
    + ' && data.project.root === ' + JSON.stringify(sourceState.board)
    + ' && data.root === view.root && view.root === ' + JSON.stringify(sourceState.board)
    + ' && !document.body.classList.contains("loading")');
  await chrome.click("document.querySelector('[data-tab=shouts]')");
  assert.equal(await chrome.stable("document.querySelector('[data-tab=shouts]').classList.contains('on') && !document.querySelector('[data-pane=shouts]').hidden"),
    true, 'the native Shouts selection is active on the newly loaded board');
  try {
    await chrome.waitFor("document.querySelector('#feed')?.textContent.includes(" + JSON.stringify(marker) + ") || document.querySelector('#relay-notice')?.textContent.includes('Could not open this board with its saved key')");
  } catch (error) {
    t.diagnostic('compressed browser read: ' + JSON.stringify(await chrome.stable("({ title: document.title, notice: document.querySelector('#relay-notice')?.textContent.slice(0, 800), signIn: document.body.textContent.includes('Sign in with GitHub'), hasMarker: document.body.textContent.includes('COMPRESSED_RELAY_SNAPSHOT_EXACT_340_'), selectedShouts: document.querySelector('[data-tab=shouts]')?.classList.contains('on') === true, paneVisible: document.querySelector('[data-pane=shouts]')?.hidden === false, addressReady: typeof addressReady !== 'undefined' && addressReady, boardReady: typeof data === 'object' && !!data?.project && data.root === view.root })")));
    throw error;
  }
  assert.equal(await chrome.stable("document.querySelector('#feed')?.textContent.includes(" + JSON.stringify(marker) + ') ?? false'), true, 'the production browser decoder reads the compressed checkpoint');
  const tablesHash = createHash('sha256').update(JSON.stringify(expected.tables)).digest('hex');
  const browserRead = await chrome.stable(`(async () => {
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
    return { projectionHash: await digest(document.state), tablesHash: await digest(native.tables),
      observedAt: native.presentation.state.observedAt, displayedObservedAt: document.state.observedAt };
  })()`);
  const { observedAt, displayedObservedAt, ...browserHashes } = browserRead;
  assert.equal(displayedObservedAt, observedAt, 'the browser retains the authenticated checkpoint observation');
  const clock = Date.parse(observedAt);
  assert.ok(Number.isSafeInteger(clock), 'the native checkpoint carries its explicit observation clock');
  // Compare complete production readers at the SAME documented observation, not two wall-clock instants.
  const projection = { ...relaySnapshot(box.root, { observedAt: clock }, RELAY_PRESENTATION_PORTS).presentation.state, root: sourceState.board };
  const projectionHash = createHash('sha256').update(JSON.stringify(projection)).digest('hex');
  assert.deepEqual(browserHashes, { projectionHash, tablesHash }, 'the production browser client reads the exact projection and browser gzip retains every native table byte');

  // An older relay that does not advertise paged snapshots keeps its explicit per-request refusal.
  box.legacySnapshotApi();
  const oversizedDocument = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
  const randomTitle = 'OVERSIZE_SNAPSHOT_340_' + randomBytes(RELAY_LIMIT).toString('base64');
  oversizedDocument.tables.board_meta.push({ meta_key: 'oversize_test_payload', meta_value: randomTitle });
  const oversizedGzip = await sealedSnapshot(box, oversizedDocument, sourceState.sequence, true);
  const oversizedBytes = Buffer.from(oversizedGzip, 'base64url').byteLength;
  assert.ok(oversizedBytes > RELAY_LIMIT, 'the compressed sealed snapshot exceeds the shared relay limit');
  assert.ok(Buffer.byteLength(JSON.stringify({ sequence: sourceState.sequence, sealed: oversizedGzip })) < BODY_LIMIT,
    'the oversized sealed snapshot remains below the shared HTTP body limit');
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const localDigest = presentationDigest(relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS).presentation);
  link.checkpoint = { sequence: sourceState.sequence, sealed: oversizedGzip };
  link.checkpointPresentationDigest = localDigest;
  writeFileSync(box.linkFile, JSON.stringify(link), { mode: 0o600 });

  const status = await textCommand(box, 'status');
  const displayedLimit = (RELAY_LIMIT / 1_000_000).toFixed(1).replace('.', '\\.');
  assert.match(status.stdout, new RegExp(`relay snapshot for ${sourceState.board}: sealed snapshot \\d+\\.\\d MB over the relay limit ${displayedLimit} MB`));
  const doctor = await textCommand(box, 'doctor');
  assert.equal(doctor.code, 1);
  const doctorJSON = await box.cliLocal('doctor');
  assert.equal(doctorJSON.code, 1);
  assert.ok(doctorJSON.document.problems.some(problem => problem.code === 'RELAY_SNAPSHOT_LIMIT'), 'doctor JSON names the stable oversize rule');
  assert.match(doctor.stdout, new RegExp(`relay snapshot for ${sourceState.board}: sealed snapshot \\d+\\.\\d MB over the relay limit ${displayedLimit} MB`));
});


test('large compressible history uses bounded pages even when its whole encrypted snapshot fits the old wire cap [H15,H17]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    store.atomic(board, () => {
      beforeShoutLimit(board, () => {
        for (let index = 0; index < 4_000; index++) store.shout(board, {
          from: 'coordinator', to: 'all', lanes: [box.lane], text: 'Retained compressible history ' + index + ' ' + 'q'.repeat(1_000),
        });
      });
    });
  } finally { store.closeBoard(board); }
  const before = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
  const raw = Buffer.from(JSON.stringify(before));
  assert.ok(raw.byteLength > 1_000_000);
  const compressedBytes = gzipSync(raw).byteLength;
  assert.ok(compressedBytes < LEGACY_RELAY_THRESHOLD, 'a whole encrypted carrier fits the former 10 MB wire cap despite a large phone decode');
  t.diagnostic(JSON.stringify({ nativeBytes: raw.byteLength, compressedBytes }));
  assert.equal((await box.cli('status')).code, 0);
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(link.snapshotApiVersion, 2, 'large retained plaintext needs paging even when its encrypted carrier compresses well');
  const response = await fetch(box.origin + '/api/v2/boards/' + link.board + '/state', {
    headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  const head = (await response.json()).state;
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const context = pagedReadContext(box, link, head, key);
  const root = await readSealedDescriptor(head.root, context);
  assert.ok(root.links[0].bytes < 1_000_000);
  const page = await openPagedSnapshot(head.root, context, { maxEngine: ENGINE_VERSION });
  const restored = await page.native();
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(hash(restored.tables), hash(before.tables), 'paged encoding retains all compressible history too');
});
