/** Shared helpers for the relay upload journeys: a loopback relay client fixture, fresh-connection fetches and checkpoint readers [H16,B26]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { gunzipSync } from 'node:zlib';
import {
  decodeBoardKey,
  unseal,
} from '../../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { legacyRelayClientFixture } from './client.js';
import { settleSubmit } from '../submit/settle.js';
import { stopFixtureLocalRunner } from '../runner/local-stop.js';

/**
 * Fetch from a loopback fixture relay on a socket of its own, never one from the global fetch pool.
 * Why: the pool keeps idle sockets by host and port; fixtures come and go on ephemeral ports, so a later fixture can
 * inherit a dead socket from an earlier one and its first request fails with 'fetch failed' (ECONNRESET) [H16].
 * An unpooled node:http request (agent: false) cannot reuse anything, and redirects stay manual as the callers expect.
 */
export function closingFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: init.method ?? 'GET', headers: init.headers ?? {}, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
        }
        const empty = [204, 205, 304].includes(response.statusCode);
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on('error', reject);
    request.end(init.body);
  });
}

/** Start the private relay fixture; its pulled gates run on the machine's loopback local runner, stopped when the test ends [P7]. */
export async function relayClientFixture(t, options) {
  const box = await legacyRelayClientFixture(t, options);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true, mode: 0o700 });
  t.after(() => stopFixtureLocalRunner(box.env.PULLBOARD_MACHINE_HOME));
  return box;
}

/** Settle a linked checkout's pulled submit: the fixture local runner takes the gate job and its receipt makes the item submitted [P7,#5821]. */
export function settleLinkedSubmit(t, box, cwd, submitted) {
  const run = async (_root, ...args) => { const ran = await box.cliAt(cwd, ...args.filter(arg => arg !== '--json')); return { code: ran.code, out: JSON.stringify(ran.document), err: '' }; };
  return settleSubmit(t, { repo: box.root, env: box.env, run }, submitted.document);
}

/** The session's link already named its pause; later local commands keep working without repeating it. */
export function assertPaused(document) {
  assert.equal((document.diagnostics ?? []).filter(line => /relay paused/u.test(line)).length, 0,
    'one session does not repeat a durable baseline pause on each command');
}

/** Authenticate the actual relay checkpoint, accepting both supported plaintext snapshot formats. */
export async function uploadedState(box) {
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const response = await closingFetch(box.origin + '/api/v1/boards/' + link.board + '/state', {
    headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(response.status, 200);
  const row = (await response.json()).state;
  const plain = await unseal(decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim()),
    Buffer.from(row.sealed, 'base64url'), { boardId: link.board, kind: 'snapshot', sequence: row.sequence });
  const bytes = plain[0] === 0x1f && plain[1] === 0x8b ? gunzipSync(plain) : plain;
  return { sequence: row.sequence, sealed: row.sealed, document: JSON.parse(new TextDecoder().decode(bytes)) };
}

/** Obtain a second real OAuth session in RAM without changing the native device's stored link. */
export async function privatePersonSession(box) {
  const start = await closingFetch(box.origin + '/auth/github/start', { redirect: 'manual' });
  const binding = start.headers.getSetCookie()[0].split(';')[0];
  const grant = await closingFetch(start.headers.get('location'), { redirect: 'manual' });
  const signed = await closingFetch(grant.headers.get('location'), { redirect: 'manual', headers: { cookie: binding } });
  assert.equal(signed.status, 303);
  const cookie = signed.headers.getSetCookie().find(value => value.startsWith('pb_session='));
  return cookie.split(';')[0].slice('pb_session='.length);
}
