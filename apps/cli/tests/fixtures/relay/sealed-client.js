/** Shared sealed-relay journey helpers: replay clients, checkpoint opening and the blocked-recovery fixture [A4,H7,H16]. */
import assert from 'node:assert/strict';
import { runFixtureChildAsync } from '../child.js';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import {
  seal as sealMove,
  unseal as openSealed,
} from '../../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { PROOF_RUN_ENGINE } from '../../../../../packages/state/light.js';

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { loadavg } from 'node:os';
import { nativeBoardPorts as relayPresentationNativePorts } from '../../../../lib/index.js';
import { openBoard } from '../../../../lib/index.js';
import * as store from '../../../../../packages/store/index.js';
import { decodeBoardKey } from '../../../../../packages/kernel/index.js';
import { readSealedDescriptor } from '../../../../../packages/pages/index.js';
import { relaySnapshot } from '../../../../../packages/pages/index.js';
import { relayClientFixture } from './client.js';

/** Open actual sealed checkpoints, accepting compressed and released legacy JSON snapshots. */
export async function openCheckpoint(box, snapshot) {
  const bytes = await openSealed(box.key, Buffer.from(snapshot.sealed, 'base64url'),
    { boardId: box.id, kind: 'snapshot', sequence: snapshot.sequence });
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Run a linked CLI asynchronously so the real relay can serve it, keeping credentials out of diagnostics. */
export function replayClient(root, env, ...args) {
  return runFixtureChildAsync(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), ...args, '--json'], { cwd: root, env })
    .then((result) => {
      if (result.failure) throw new Error(result.failure);
      try { return JSON.parse(withoutDiagnostics(result.stdout)); }
      catch { throw new Error(`${result.failure ?? result.context}\nstdout (${result.stdout.length} chars, not one JSON document): ${result.stdout}`); }
    });
}

/** Drop the trailing diagnostics envelope a --json command prints after its own document when the engine warned (a future-engine blocker). */
function withoutDiagnostics(stdout) {
  const at = stdout.lastIndexOf('\n{\n  "version": 1,\n  "messages"');
  return at === -1 ? stdout : stdout.slice(0, at);
}

/** Initialize an import recipient without declaring a second coordinator; later commands retain their model. */
export function initializeReplica(root, env) {
  const initEnv = { ...env };
  delete initEnv.PULLBOARD_MODEL;
  return replayClient(root, initEnv, 'init');
}

/** Replay through the native CLI while acknowledging but suppressing checkpoint writes to the fixture relay. */
export function replayClientWithoutCheckpoint(root, env) {
  const cliURL = pathToFileURL(resolve(import.meta.dirname, '../native.js')).href;
  const script = `
    import { main } from ${JSON.stringify(cliURL)};
    const realFetch = globalThis.fetch;
    let checkpointWrites = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (init.method === 'PUT' && /\\/state(?:\\?|$)/.test(url)) {
        checkpointWrites += 1;
        return new Response(JSON.stringify({ version: 1, state: JSON.parse(init.body) }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    };
    let output = '';
    let diagnostics = '';
    const code = await main(['export', '--json'], { cwd: process.cwd(), stdout: { write(part) { output += part; } }, stderr: { write(part) { diagnostics += part; } } });
    console.log(JSON.stringify({ code, checkpointWrites, document: JSON.parse(output), diagnosticCount: diagnostics.length }));
  `;
  return runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env }).then((result) => {
    if (result.failure) throw new Error(result.failure);
    try { return JSON.parse(result.stdout); }
    catch { throw new Error(result.failure ?? result.context); }
  });
}

/** Keep each client on its own replay path by blocking checkpoint publication, forwarding all reads to the real relay. */
export async function independentReplayOrigin(t, origin) {
  const proxy = createServer(async (request, response) => {
    if (request.method === 'PUT' && request.url.endsWith('/state')) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 1, error: { code: 'HUMAN_REQUIRED', message: 'fixture checkpoint publication disabled' } }));
      return;
    }
    try {
      const reply = await fetch(origin + request.url, { headers: {
        authorization: request.headers.authorization ?? '',
        'x-pullboard-engine': request.headers['x-pullboard-engine'] ?? '',
        ...(request.headers.accept ? { accept: request.headers.accept } : {}),
      } });
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(Buffer.from(await reply.arrayBuffer()));
    } catch {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 1, error: { code: 'RELAY_UNAVAILABLE', message: 'fixture relay unavailable' } }));
    }
  });
  await new Promise((done, fail) => { proxy.once('error', fail); proxy.listen(0, '127.0.0.1', done); });
  t.after(() => new Promise(done => proxy.close(done)));
  return 'http://127.0.0.1:' + proxy.address().port;
}

/** Parse one --json document; a trailing diagnostics envelope (printed when the engine warned) becomes its `diagnostics` list. */
function parseWithDiagnostics(stdout) {
  const document = JSON.parse(withoutDiagnostics(stdout));
  const rest = stdout.slice(withoutDiagnostics(stdout).length);
  if (rest === '') return document;
  return { ...document, diagnostics: JSON.parse(rest).diagnostics ?? [] };
}

/** Capture a real linked command's warnings and structured refusal without changing its exit status. */
export function replayResult(root, env, ...args) {
  return runFixtureChildAsync(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), ...args, '--json'], { cwd: root, env })
    .then((result) => {
      if (result.error) throw new Error(result.failure);
      try { return { document: parseWithDiagnostics(result.stdout), stderr: result.failure ?? result.stderr, status: result.status, failure: result.failure }; }
      catch { throw new Error(`${result.failure ?? result.context}\nstdout (${result.stdout.length} chars, not one JSON document): ${result.stdout}`); }
    });
}
/** Link one private fixture to a real relay with an engine-99 blocker at sequence one. */
export async function blockedRecoveryFixture(box) {
  mkdirSync(join(box.home, 'relay-keys'), { mode: 0o700 });
  writeFileSync(join(box.home, 'relay-keys', box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
  writeFileSync(join(box.root, '.git/pullboard/relay.json'), JSON.stringify({ version: 1, mode: 'ordered', board: box.id,
    url: box.origin, repository: 'fixture/repository', token: box.machines[0].token, sequence: 0, cursor: box.document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
  const initial = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(box.document)), { boardId: box.id, kind: 'snapshot', sequence: 0 })).toString('base64url');
  assert.equal((await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: initial } })).status, 200);
  const future = { version: 1, engine: ENGINE_VERSION + 1, id: 'future-engine-record', operation: 'futureOperation', args: [] };
  const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(future)), { boardId: box.id, kind: 'move', sequence: 1 })).toString('base64url');
  assert.equal((await box.call(box.path + '/moves', { method: 'POST', token: box.one.token, body: { sequence: 1, sealed } })).status, 200);
  return { future, sealed };
}

/** Preserve every SQLite value while normalizing row prototypes for JSON transport comparisons. */
export function plainRows(rows) { return rows.map(row => ({ ...row })); }

/** Normalize all exported tables without dropping columns or changing their order. */
export function plainTables(tables) { return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, plainRows(rows)])); }

/**
 * Write shouts the way a board upgraded from before the 400-character limit (#1109) holds them.
 * Replay applies a move at its recorded engine, so this history stays as long as it was written.
 */
export function beforeShoutLimit(board, write) {
  const recorded = Object.hasOwn(board, 'executionEngineVersion') ? board.executionEngineVersion : undefined;
  board.executionEngineVersion = PROOF_RUN_ENGINE - 1;
  try { return write(); } finally {
    if (recorded === undefined) delete board.executionEngineVersion; else board.executionEngineVersion = recorded;
  }
}

/** Authenticate one private fixture object's graph path without exposing credentials in diagnostics. */
export function pagedReadContext(box, link, head, key) {
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

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

const LEGACY_RELAY_THRESHOLD = 10_000_000;

/** Select an old event leaf, so a controlled background hold cannot accidentally block the current-state boot. */
export async function oldestEventPage(head, context) {
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
export async function thirtyThousandBoard(t) {
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
      for (let index = 0; index < 450; index++) store.addItem(native, {
        by: 'coordinator', lane: box.lane, title: index === 449 ? currentMarker : 'Retained current work ' + index, route: 'strong',
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
  assert.ok(before.tables.event.length >= 30_000 && before.tables.event.length < 31_000, 'event count ' + before.tables.event.length);
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

/** Whether the page met #903's first-readable-board bar, by the page's own measure of its first board paint. */
export function paintWithinBudget(first) {
  return Number.isFinite(first.firstBoardPaint) && first.firstBoardPaint < 3000;
}

/**
 * Assert #903's 3,000 ms first-board bar on the page's own measure when the machine's 1-minute load, sampled before and
 * after the open, stays under half its core count. Otherwise a dev machine is not the phone the budget is for, so the
 * page must still have painted within the test's wait, and the paint is logged with both load samples (#953).
 */
export function assertFirstPaint(t, first, label, { after = loadavg()[0], cores = availableParallelism() } = {}) {
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
export function cpuStandIn(t) {
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

/** Cell doors the split sealed recovery journeys read through this fixture, so the journeys carry no cell imports [H16]. */
export { exportBoard } from '../../../../../packages/store/index.js';
export { semanticBoardDigest } from '../../../../../packages/store/index.js';
export { appliedSequence } from '../../../../../packages/state/index.js';
export { checkpointSequence } from '../../../../../packages/state/index.js';
export { requireSupportedEngine } from '../../../../../packages/state/index.js';
export { seal as sealMove } from '../../../../../packages/kernel/index.js';
export { store, openBoard, ENGINE_VERSION };

/** Relay doors of the link cell, re-exported for the split sealed recovery journeys [H16]. */
export { relayRecover } from '../../../../../packages/link/index.js';
export { syncRelay } from '../../../../../packages/link/index.js';
