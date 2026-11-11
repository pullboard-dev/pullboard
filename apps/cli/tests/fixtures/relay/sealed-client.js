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
import { createServer } from 'node:http';
import {
  seal as sealMove,
  unseal as openSealed,
} from '../../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { PROOF_RUN_ENGINE } from '../../../../../packages/state/light.js';

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
      try { return JSON.parse(result.stdout); }
      catch { throw new Error(result.failure ?? result.context); }
    });
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

/** Capture a real linked command's warnings and structured refusal without changing its exit status. */
export function replayResult(root, env, ...args) {
  return runFixtureChildAsync(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), ...args, '--json'], { cwd: root, env })
    .then((result) => {
      if (result.error) throw new Error(result.failure);
      try { return { document: JSON.parse(result.stdout), stderr: result.failure ?? result.stderr, status: result.status, failure: result.failure }; }
      catch { throw new Error(result.failure ?? result.context); }
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
