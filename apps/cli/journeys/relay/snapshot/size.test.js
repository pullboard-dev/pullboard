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
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  gzipSync,
  gunzipSync,
} from 'node:zlib';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { loadavg } from 'node:os';
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
  findChromeExecutable,
  startChrome,
} from '../../../tests/fixtures/relay/browser.js';
import { readSealedDescriptor } from '../../../../../packages/pages/index.js';
import { openPagedSnapshot } from '../../../../../packages/pages/index.js';
import { PROOF_RUN_ENGINE } from '../../../../../packages/state/light.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

const LEGACY_BODY_THRESHOLD = 14_000_000;
const LEGACY_RELAY_THRESHOLD = 10_000_000;
const SIGNED_IN_BOARD_RENDER_WAIT_MS = 15_000;

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

/**
 * Write shouts the way a board upgraded from before the 400-character limit (#1109) holds them.
 * Replay applies a move at its recorded engine, so this history stays as long as it was written.
 */
function beforeShoutLimit(board, write) {
  const recorded = Object.hasOwn(board, 'executionEngineVersion') ? board.executionEngineVersion : undefined;
  board.executionEngineVersion = PROOF_RUN_ENGINE - 1;
  try { return write(); } finally {
    if (recorded === undefined) delete board.executionEngineVersion; else board.executionEngineVersion = recorded;
  }
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
  const pairing = await box.cli('relay', 'pair');
  const second = await box.otherDeviceJoin(pairing.document.code);

  // An ordinary older JSON snapshot remains readable by the CLI after the relay compacts it.
  assert.equal((await box.cli('add', box.lane, 'legacy snapshot cursor')).code, 0);
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
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const phone = await box.phoneSession();
  const cookie = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: phone.token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(cookie.success, true, 'Chrome accepted the signed-in phone session cookie');
  const encodedKey = readFileSync(box.keyFile, 'utf8').trim();
  await chrome.navigate(box.origin + '/#board=' + sourceState.board + '&key=' + encodedKey);
  await chrome.waitFor('location.origin === ' + JSON.stringify(box.origin) + ' && document.readyState === "complete"');
  const inventory = await chrome.evaluate(`(async () => {
    const response = await fetch('/api/v1/boards', { credentials: 'same-origin' });
    let value = null; try { value = await response.json(); } catch {}
    return { status: response.status, boardIds: (value?.boards ?? []).map(board => board.id), error: value?.error?.code ?? null };
  })()`);
  assert.equal(inventory.status, 200, `the signed-in page reads its relay inventory: ${JSON.stringify(inventory)}`);
  assert.ok(inventory.boardIds.includes(sourceState.board), `the browser account can see this linked board: ${JSON.stringify(inventory)}`);
  assert.deepEqual(await chrome.evaluate(`(async () => {
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
    t.diagnostic('signed-in relay board read: ' + JSON.stringify(await chrome.evaluate(`(() => ({
      activeTab: typeof view !== 'undefined' ? view.tab : null,
      itemTitles: typeof data !== 'undefined' && Array.isArray(data?.project?.items) ? data.project.items.slice(0, 5).map(item => item.title) : [],
      notice: document.querySelector('#relay-notice')?.textContent.slice(0, 800),
    }))()`)));
    throw error;
  }
  assert.equal(await chrome.evaluate(`(() => { document.querySelector('[data-tab="items"]')?.click(); return document.querySelector('[data-tab="items"]')?.classList.contains('on'); })()`), true,
  'the browser shows the Items tab before checking its chain');
  try {
    await chrome.waitFor("document.querySelector('#chain')?.textContent.includes('legacy snapshot cursor')");
  } catch (error) {
    t.diagnostic('legacy browser read: ' + JSON.stringify(await chrome.evaluate(`(() => ({
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
  assert.equal((await box.cli('add', box.lane, 'advance compressed snapshot')).code, 0, 'an acknowledged move advances the relay snapshot cursor');
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
  const previousDocument = await chrome.evaluate('performance.timeOrigin');
  await chrome.navigate(box.origin);
  // The feed renders when its native tab is selected, rather than while Items is open.
  await chrome.waitFor('performance.timeOrigin !== ' + JSON.stringify(previousDocument)
    + ' && document.readyState === "complete" && typeof data === "object" && !!data?.project && addressReady'
    + ' && data.project.root === ' + JSON.stringify(sourceState.board)
    + ' && data.root === view.root && view.root === ' + JSON.stringify(sourceState.board)
    + ' && !document.body.classList.contains("loading")');
  await chrome.evaluate("document.querySelector('[data-tab=shouts]').click(); true");
  assert.equal(await chrome.evaluate("document.querySelector('[data-tab=shouts]').classList.contains('on') && !document.querySelector('[data-pane=shouts]').hidden"),
    true, 'the native Shouts selection is active on the newly loaded board');
  try {
    await chrome.waitFor("document.querySelector('#feed')?.textContent.includes(" + JSON.stringify(marker) + ") || document.querySelector('#relay-notice')?.textContent.includes('Could not open this board with its saved key')");
  } catch (error) {
    t.diagnostic('compressed browser read: ' + JSON.stringify(await chrome.evaluate("({ title: document.title, notice: document.querySelector('#relay-notice')?.textContent.slice(0, 800), signIn: document.body.textContent.includes('Sign in with GitHub'), hasMarker: document.body.textContent.includes('COMPRESSED_RELAY_SNAPSHOT_EXACT_340_'), selectedShouts: document.querySelector('[data-tab=shouts]')?.classList.contains('on') === true, paneVisible: document.querySelector('[data-pane=shouts]')?.hidden === false, addressReady: typeof addressReady !== 'undefined' && addressReady, boardReady: typeof data === 'object' && !!data?.project && data.root === view.root })")));
    throw error;
  }
  assert.equal(await chrome.evaluate("document.querySelector('#feed')?.textContent.includes(" + JSON.stringify(marker) + ') ?? false'), true, 'the production browser decoder reads the compressed checkpoint');
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
    return { projectionHash: await digest(document.state), tablesHash: await digest(native.tables),
      observedAt: native.presentation.state.observedAt, displayedObservedAt: document.state.observedAt };
  })()`, 'hash browser projection and native snapshot');
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
  const doctorJSON = await box.cli('doctor');
  assert.equal(doctorJSON.code, 1);
  assert.ok(doctorJSON.document.problems.some(problem => problem.code === 'RELAY_SNAPSHOT_LIMIT'), 'doctor JSON names the stable oversize rule');
  assert.match(doctor.stdout, new RegExp(`relay snapshot for ${sourceState.board}: sealed snapshot \\d+\\.\\d MB over the relay limit ${displayedLimit} MB`));
});

/** Authenticate one private fixture object's graph path without exposing credentials in diagnostics. */
function pagedReadContext(box, link, head, key) {
  return { boardId: link.board, key, sequence: head.sequence,
    /** Public HTTP still checks the principal's pinned root; only this device interprets the sealed directory. */
    async get(id, parents) {
      const response = await fetch(box.origin + '/api/v2/boards/' + link.board + '/objects/' + id
        + '?pin=' + head.read.id + '&via=' + parents.join(','), {
        headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
      });
      const document = await response.json();
      assert.equal(response.status, 200, document.error?.message);
      return Buffer.from(document.page.sealed, 'base64url');
    },
  };
}

/** Select an old event leaf, so a controlled background hold cannot accidentally block the current-state boot. */
async function oldestEventPage(head, context) {
  const root = await readSealedDescriptor(head.root, context);
  const event = root.value.tables.indexOf('event');
  assert.ok(event >= 0);
  let reference = root.links[event + 3], parents = [head.root.id];
  for (;;) {
    const node = await readSealedDescriptor(reference, { ...context, parents });
    const range = node.value.entries[0], child = node.links[0];
    assert.ok(range && child);
    if (range.leaf) return child.id;
    parents = [...parents, reference.id]; reference = child;
  }
}

/**
 * A linked board with thirty thousand events, its oldest shout and over thirty megabytes of sealed history uploaded
 * through API2 pages, as #903's phone case builds it (#953 shares it).
 */
async function thirtyThousandBoard(t) {
  const box = await relayClientFixture(t);
  const transitStart = box.transit.length;
  await box.link();
  const pairing = await box.cli('relay', 'pair');
  const second = await box.otherDeviceJoin(pairing.document.code);
  const currentMarker = 'PAGED_CURRENT_STATE_903';
  const oldestMarker = 'PAGED_OLDEST_SHOUT_903';
  const liveMarker = 'LIVE_MOVE_DURING_HISTORY_903';
  const native = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let oldest;
  try {
    // These are synthetic native fixture moves in one normal board transaction, never owner-board edits.
    store.atomic(native, () => {
      for (let index = 0; index < 900; index++) store.addItem(native, {
        by: 'coordinator', lane: box.lane, title: index === 899 ? currentMarker : 'Retained current work ' + index, route: 'strong',
      });
      oldest = store.shout(native, { from: 'coordinator', to: 'all', text: oldestMarker, lanes: [box.lane] });
      // Incompressible retained history proves several times the old cap in actual uploaded cipher bytes.
      beforeShoutLimit(native, () => {
        for (let index = 0; index < 32; index++) store.shout(native, {
          from: 'coordinator', to: 'all', text: 'Private historical data ' + index + ':' + randomBytes(1_000_000).toString('base64'), lanes: [box.lane],
        });
      });
      for (let index = 0; index < 30_017; index++) store.shout(native, {
        from: 'coordinator', to: 'all', text: 'Recent and retained work ' + index, lanes: [box.lane],
      });
    });
    assert.equal(store.allShouts(native)[0].shout_id, oldest, 'the addressed marker really is this board\'s oldest shout');
  } finally { store.closeBoard(native); }
  const before = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
  assert.ok(before.tables.event.length >= 30_000 && before.tables.event.length < 32_000, 'event count ' + before.tables.event.length);
  assert.ok(gzipSync(Buffer.from(JSON.stringify(before))).byteLength > LEGACY_RELAY_THRESHOLD * 3, 'even compressed whole-board state is several times the old limit');
  const uploadedStatus = await box.cli('status');
  assert.equal(uploadedStatus.code, 0, 'the actual opted-in CLI publishes through bounded pages');
  // The relay's own record across the link-and-status window is the proof of upload work: under load an upload can
  // finish before this one status call, which then observes none (#953). It still fails when nothing was uploaded.
  const windowWork = box.transit.slice(transitStart);
  const objectPuts = windowWork.filter(row => row.method === 'PUT' && /\/api\/v2\/boards\/[^/]+\/uploads\/[^/]+\/objects\//u.test(row.path));
  const publishes = windowWork.filter(row => row.method === 'POST' && /\/api\/v2\/boards\/[^/]+\/uploads\/[^/]+\/publish$/u.test(row.path));
  assert.ok(objectPuts.reduce((sum, row) => sum + row.request.byteLength, 0) > 0 && publishes.length > 0,
    'API2 page bytes and actual checkpoint attempts contribute non-zero recorded work across the link-and-status window');
  if (uploadedStatus.snapshotWork.observed) {
    assert.ok(uploadedStatus.snapshotWork.budgetUnits <= 6 && !uploadedStatus.snapshotWork.overLimit, 'observed attempts and bytes stay bounded without raising the existing time allowance');
  }
  t.diagnostic(JSON.stringify({ api2UploadWork: uploadedStatus.snapshotWork, derivedChildDeadlineMs: uploadedStatus.snapshotDeadlineMs }));
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(link.snapshotApiVersion, 2);
  assert.equal(link.checkpoint, undefined);
  const writes = box.transit.filter(row => row.method === 'PUT' && /\/api\/v2\/boards\/[^/]+\/uploads\/[^/]+\/objects\//u.test(row.path));
  const uploaded = new Map(writes.map(row => [row.path.split('/').at(-1), Buffer.from(JSON.parse(row.request).sealed, 'base64url').byteLength]));
  const cipherBytes = [...uploaded.values()].reduce((sum, bytes) => sum + bytes, 0);
  assert.ok(cipherBytes > LEGACY_RELAY_THRESHOLD * 3, 'real unique encrypted upload objects exceed thirty million bytes');
  assert.ok(writes.every(row => row.request.byteLength < 600_000), 'no request carries the whole board');
  assert.ok(writes.every(row => !row.request.includes(Buffer.from(oldestMarker))), 'the relay stores no historical plaintext');
  const headers = { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) };
  const headResponse = await fetch(box.origin + '/api/v2/boards/' + link.board + '/state', { headers });
  const head = (await headResponse.json()).state;
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const context = pagedReadContext(box, link, head, key);
  const root = await readSealedDescriptor(head.root, context);
  assert.ok(root.links[0].bytes < 1_000_000, 'the authenticated current-state plaintext budget is under one megabyte');
  const heldPage = await oldestEventPage(head, context);
  return { box, pairing, second, currentMarker, oldestMarker, liveMarker, oldest, before, uploadedStatus, link, writes, uploaded, cipherBytes, headers, headResponse, head, key, context, root, heldPage };
}

/**
 * Open that board on a fresh phone-sized Chrome and return the page's own timing once it has painted the current
 * board. holdStateMs is a test-only delay on the phone's current-state read, which holds the first paint (#953).
 */
async function openOnPhone(t, { box, link, heldPage, currentMarker }, { holdStateMs = 0 } = {}) {
  const loadBefore = loadavg()[0];
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: String.raw`
    window.__phoneTiming = { firstBoardPaint: null, objectRequests: 0, loopbackReads: 0, historyHeld: false };
    window.__holdStateMs = ${holdStateMs};
    window.__releaseOlderHistory = null;
    const originalFetch = window.fetch;
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (['http://127.0.0.1:4890', 'http://localhost:4890'].includes(url.origin)) {
        __phoneTiming.loopbackReads++; throw new TypeError('No local view in this private phone fixture');
      }
      if (/\/api\/v2\/boards\/[^/]+\/objects\//u.test(url.pathname)) __phoneTiming.objectRequests++;
      if (window.__holdStateMs && /\/api\/v2\/boards\/[^/]+\/state$/u.test(url.pathname)) {
        const held = window.__holdStateMs; window.__holdStateMs = 0;
        await new Promise(resolveHold => setTimeout(resolveHold, held));
      }
      if (url.pathname.endsWith('/objects/${heldPage}') && !window.__olderHistoryAllowed) {
        __phoneTiming.historyHeld = true;
        await new Promise(resolveHistory => { window.__releaseOlderHistory = resolveHistory; });
      }
      return originalFetch(input, options);
    };
    let queued = false;
    new MutationObserver(() => {
      const node = document.querySelector('#chain');
      if (queued || !node?.textContent.includes('${currentMarker}') || !node.getBoundingClientRect().height) return;
      queued = true;
      requestAnimationFrame(() => { __phoneTiming.firstBoardPaint = performance.now(); });
    }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  ` });
  await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
  // Budget: the owner's explicit first-readable-board bar is three seconds, independent of historical streaming.
  // The product bar is the page's own firstBoardPaint < 3000 ms; this wait only has to outlast a loaded runner (#953).
  try {
    await chrome.waitFor('Number.isFinite(window.__phoneTiming?.firstBoardPaint) && typeof transport !== "undefined" && !!transport?.historyProgress', 120_000, 'bounded current board paints before all history'); // budget: generous hang ceiling for a starved harness to observe the paint under gate load (a 30 s wait expired with the page painted at 646 ms); the frozen #903 3000ms bar is asserted on the page-measured firstBoardPaint.
  } catch (error) {
    // Record what the page itself reached, so a miss reads as a page measurement rather than a runner timeout (#953).
    const page = await chrome.evaluate(`({ ...window.__phoneTiming, sinceNavigationMs: performance.now(), readyState: document.readyState,
      transport: typeof transport, historyProgress: typeof transport?.historyProgress, chain: Boolean(document.querySelector('#chain')), loading: document.body?.classList.contains('loading') })`).catch(() => null);
    t.diagnostic(JSON.stringify({ phonePageAtTimeout: page }));
    error.message += '; the page reached ' + JSON.stringify(page);
    throw error;
  }
  const first = await chrome.evaluate(`({ ...__phoneTiming, phone: document.documentElement.dataset.relayDevice, progress: transport.historyProgress('${link.board}') })`);
  return { chrome, first: { ...first, loadBefore } };
}

test('thirty thousand events open on the phone within three seconds and stream all sealed history beside live moves [H5,H15,H17]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const { box, pairing, second, currentMarker, oldestMarker, liveMarker, oldest, before, uploadedStatus, link, writes, uploaded, cipherBytes, headers, headResponse, head, key, context, root, heldPage } = await thirtyThousandBoard(t);
  const { chrome, first } = await openOnPhone(t, { box, link, heldPage, currentMarker });
  assert.equal(first.phone, 'phone'); assertFirstPaint(t, first, 'the 30k open');
  assert.equal(first.loopbackReads, 0); assert.equal(first.progress.complete, false);
  // Budget: this fixture streams thirty thousand historical records before reaching its deliberately held oldest event leaf.
  const historyStarted = Date.now();
  await chrome.waitFor('window.__phoneTiming.historyHeld', 120_000, 'old history is streaming after the first readable board'); // budget: generous hang ceiling for the held oldest-event-page handshake under suite load; the time is logged, never a throughput claim (#953).
  t.diagnostic(`old history reached its held page ${Date.now() - historyStarted} ms after the first paint at load ${loadavg()[0].toFixed(1)}`);
  try {
    assert.equal((await box.cli('add', box.lane, liveMarker)).code, 0, 'ordinary native moves continue while old history is pinned');
    await chrome.waitFor(`document.querySelector('#chain')?.textContent.includes('${liveMarker}')`, 15_000, 'new current state arrives while an older history page is held'); // budget: hang ceiling for the live-move handshake while old history is held, not a throughput claim.
  } finally {
    await chrome.evaluate('window.__olderHistoryAllowed = true; window.__releaseOlderHistory?.(); true');
  }
  const expected = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
  const finalSequence = Number(expected.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value);
  // Budget: a complete loopback replay includes both the pinned predecessor and its live successor, never the three-second boot bar.
  await chrome.waitFor(`transport.historyProgress('${link.board}').complete && transport.historyProgress('${link.board}').sequence === ${finalSequence}`, 45_000, 'all sealed history is held at the live checkpoint'); // budget: hang ceiling for two complete pinned background streams; the 3s boot bar is measured separately.
  const oldestHash = createHash('sha256').update(oldestMarker).digest('hex');
  const read = await chrome.evaluate(`(async () => {
    const before = __phoneTiming.objectRequests;
    const reply = await transport.request('/api/v1/boards/${link.board}/shouts/${oldest}');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(reply.shout.shout_text)));
    return { hash: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''), extraObjectReads: __phoneTiming.objectRequests - before,
      progress: transport.historyProgress('${link.board}'), loopbackReads: __phoneTiming.loopbackReads };
  })()`);
  assert.equal(read.hash, oldestHash); assert.equal(read.extraObjectReads, 0, 'the oldest shout is already held after the background stream');
  assert.equal(read.progress.loaded, read.progress.total); assert.equal(read.loopbackReads, 0);
  await chrome.evaluate(`location.hash = '#shout-${oldest}'; true`);
  await chrome.waitFor(`document.body.innerText.includes('${oldestMarker}')`, 3000, 'the actual phone view opens the streamed oldest shout'); // budget: hang ceiling for the addressed-shout render handshake after history completion.
  assert.equal((await second.cli('status')).code, 0, 'an independent paired CLI restores the same paged checkpoint');
  const restored = await second.cli('export');
  assert.equal(restored.code, 0);
  const nativeDigest = value => createHash('sha256').update(JSON.stringify(plainTables(value))).digest('hex');
  assert.equal(nativeDigest(restored.document.tables), nativeDigest(expected.tables), 'every native row, counter and receipt is retained');
  const metrics = { firstPaintMs: first.firstBoardPaint, events: expected.tables.event.length, uniqueCipherBytes: cipherBytes,
    largestUploadBody: Math.max(...writes.map(row => row.request.byteLength)), currentSnapshotBytes: root.links[0].bytes,
    progress: read.progress, oldestHash, nativeTablesHash: nativeDigest(expected.tables) };
  t.diagnostic(JSON.stringify(metrics));
  if (process.env.PULLBOARD_RELAY_PAGE_PROOF) {
    const output = process.env.PULLBOARD_RELAY_PAGE_PROOF;
    mkdirSync(output, { recursive: true, mode: 0o700 });
    writeFileSync(join(output, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n', { mode: 0o600 });
    const screenshot = await chrome.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, 'oldest-shout-phone.png'), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
  }
});

/** Whether the page met #903's first-readable-board bar, by the page's own measure of its first board paint. */
function paintWithinBudget(first) {
  return Number.isFinite(first.firstBoardPaint) && first.firstBoardPaint < 3000;
}

/**
 * Assert #903's 3,000 ms first-board bar on the page's own measure when the machine's 1-minute load, sampled before and
 * after the open, stays under half its core count. Otherwise a dev machine is not the phone the budget is for, so the
 * page must still have painted within the test's wait, and the paint is logged with both load samples (#953).
 */
function assertFirstPaint(t, first, label, { after = loadavg()[0], cores = availableParallelism() } = {}) {
  const bound = cores / 2;
  const loads = `load ${first.loadBefore.toFixed(1)} before, ${after.toFixed(1)} after`;
  // The busy-machine fallback is still a page-clock bound: the page paints within 30 s by its own measure, while the
  // harness may wait longer to observe it (#953 review).
  assert.ok(Number.isFinite(first.firstBoardPaint) && first.firstBoardPaint < 30_000, `${label}: the page painted its board within 30 s by its own clock: ${first.firstBoardPaint} ms`);
  if (first.loadBefore < bound && after < bound) assert.ok(paintWithinBudget(first), `${label}: page-measured first paint ${first.firstBoardPaint} ms is under 3000 ms at ${loads}`);
  else t.diagnostic(`${label}: page-measured first paint ${Math.round(first.firstBoardPaint)} ms; budget not asserted at ${loads}, bound ${bound}`);
}

/**
 * Hold busy processes on half the cores, as a loaded suite shares the CPU with the runner and Chrome; stop each by its
 * own pid. A machine whose 1-minute load is already at half its core count is loaded enough, so no stand-in is added
 * and one line says so: stacking more on a busy gate machine starves the harness rather than measuring the page (#953).
 */
function cpuStandIn(t) {
  const [load] = loadavg();
  const cores = availableParallelism();
  if (load >= cores / 2) {
    t.diagnostic(`no CPU stand-in added: the 1-minute load ${load.toFixed(1)} is already at or above half of ${cores} cores`);
    return { stop() {}, count: 0, load };
  }
  const busy = Array.from({ length: Math.max(1, Math.floor(cores / 2)) },
    () => spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
  const stop = () => { for (const child of busy) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  t.after(stop);
  return { stop, count: busy.length, load };
}

test("the phone's first-paint budget is judged by the page, not by a loaded test runner [H5]", {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  // The judgement itself, at its boundaries: 3 s on a quiet machine, the 30 s page-clock fallback on a busy one.
  const quiet = { after: 1, cores: 14 };
  const busy = { after: 99, cores: 14 };
  assertFirstPaint(t, { firstBoardPaint: 2_999, loadBefore: 1 }, 'quiet boundary', quiet);
  assert.throws(() => assertFirstPaint(t, { firstBoardPaint: 3_001, loadBefore: 1 }, 'quiet boundary', quiet));
  assertFirstPaint(t, { firstBoardPaint: 29_999, loadBefore: 99 }, 'busy boundary', busy);
  assert.throws(() => assertFirstPaint(t, { firstBoardPaint: 30_001, loadBefore: 99 }, 'busy boundary', busy));
  const board = await thirtyThousandBoard(t);
  const load = cpuStandIn(t);
  const paints = [];
  try {
    for (let run = 0; run < 5; run++) {
      const { chrome, first } = await openOnPhone(t, board);
      assertFirstPaint(t, first, `run ${run + 1}`);
      paints.push(first.firstBoardPaint);
      t.diagnostic(JSON.stringify({ run: run + 1, firstBoardPaintMs: Math.round(first.firstBoardPaint) }));
      await chrome.close();
    }
  } finally { load.stop(); }
  t.diagnostic(JSON.stringify({ cpuStandIn: load.count, loadBefore: Number(load.load.toFixed(1)), firstBoardPaintMs: paints.map(ms => Math.round(ms)) }));
  // A test-only hold on the phone's current-state read really delays the paint past the bar, and the judgement turns red.
  const { chrome, first } = await openOnPhone(t, board, { holdStateMs: 3_500 });
  await chrome.close();
  assert.ok(first.firstBoardPaint >= 3000, `the held state read delays the page's own paint: ${first.firstBoardPaint}`);
  assert.equal(paintWithinBudget(first), false, 'a paint past three seconds fails the bar');
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
