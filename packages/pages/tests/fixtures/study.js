/** Shared authenticated readers for the measured private relay study [H5,H17]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request as httpRequest,
} from 'node:http';
import { performance } from 'node:perf_hooks';
import { ENGINE_VERSION } from '../../../state/index.js';
import { decodeBoardKey } from '../../../kernel/index.js';
import { openPagedSnapshot } from '../../index.js';

/**
 * Whether a field is a reading of the clock rather than board data: a sealed page states its as-of time, so the
 * publisher's and the comparing reader's values differ by the seconds between them (coordinator ruling 31625).
 */
function asOfField(path, name) {
  return ['observedAt', 'asOf', 'ageMinutes'].includes(name) || name === 'minutes' && (path.includes('["stages"]') || path.includes('.stages.'));
}

/** Compare every JSON field except as-of clock readings, retaining paths but never printing board contents or credentials. */
export function differences(left, right, path = '$', found = []) {
  if (Object.is(left, right)) return found;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object'
      || Array.isArray(left) !== Array.isArray(right)) {
    found.push(path);
    return found;
  }
  for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const next = path + '[' + JSON.stringify(name) + ']';
    if (asOfField(path, name) && Object.hasOwn(left, name) && Object.hasOwn(right, name)) continue;
    if (!Object.hasOwn(left, name) || !Object.hasOwn(right, name)) found.push(next);
    else differences(left[name], right[name], next, found);
  }
  return found;
}

/** Read the actual private API2 root and ciphertext pages through the production decoder. */
export async function readRelay(box) {
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const headers = { authorization: 'Bearer ' + state.token, 'x-pullboard-engine': String(ENGINE_VERSION) };
  let requests = 0, receivedBytes = 0;
  /** Count actual HTTP response bytes before decoding their JSON, without logging secrets. */
  async function request(path) {
    const response = await fetch(box.origin + path, { headers });
    const bytes = Buffer.from(await response.arrayBuffer());
    requests++; receivedBytes += bytes.byteLength;
    assert.equal(response.status, 200, 'the private relay accepted its authenticated read');
    return JSON.parse(bytes.toString('utf8'));
  }
  const started = performance.now();
  const response = await request('/api/v2/boards/' + state.board + '/state');
  const saved = response.state;
  assert.equal(response.apiVersion, 2);
  assert.equal(saved.apiVersion, 2, 'measure the current paged protocol');
  const page = await openPagedSnapshot(saved.root, {
    key: decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim()), boardId: state.board, sequence: saved.sequence,
    /** Follow only the server-pinned opaque page graph, exactly as the production reader does. */
    async get(id, parents) {
      const result = await request('/api/v2/boards/' + state.board + '/objects/' + id
        + '?pin=' + encodeURIComponent(saved.read.id) + '&via=' + parents.join(','));
      assert.equal(result.apiVersion, 2);
      assert.equal(result.page.id, id);
      return Buffer.from(result.page.sealed, 'base64url');
    },
  }, { maxEngine: ENGINE_VERSION });
  const document = await page.native();
  return { document, requests, receivedBytes, readMs: performance.now() - started };
}


/**
 * Put a real HTTP fault proxy between the linked CLI and the fixture relay by pointing this scratch board's link at
 * it. API requests can be delayed, or answered with a refusal, without changing the shared relay fixture.
 */
export async function faultProxy(t, box, { rewriteLink = true } = {}) {
  const target = new URL(box.origin);
  let fault = null;
  const server = createServer((req, res) => {
    /** Forward one request unchanged, after any configured delay or instead of a configured refusal. */
    async function handle() {
      const api = (req.url ?? '').startsWith('/api/');
      if (api && fault?.down) { req.socket.destroy(); return; }
      if (api && fault?.delayMs) await new Promise(resolve => setTimeout(resolve, fault.delayMs));
      if (api && fault?.status) {
        req.resume();
        res.writeHead(fault.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: 1, error: { code: fault.code, message: 'private study fault' } }));
        return;
      }
      const upstream = httpRequest({ host: target.hostname, port: target.port, method: req.method, path: req.url,
        headers: { ...req.headers, host: target.host, ...(req.headers.origin ? { origin: box.origin } : {}) } }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    }
    handle().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  if (rewriteLink) writeFileSync(box.linkFile, JSON.stringify({ ...JSON.parse(readFileSync(box.linkFile, 'utf8')), url: origin }), { mode: 0o600 });
  return {
    origin,
    /** Drop every open connection, so a live stream must reconnect through the current fault. */
    drop() { server.closeAllConnections(); },
    /** Set the fault for later API requests: { down } or { delayMs, status, code }, or null to pass them through. */
    set(value = null) {
      assert.ok(value === null || value.down === true || Number.isSafeInteger(value.delayMs) && value.delayMs >= 0
        && (value.status === null || [409, 503].includes(value.status)));
      fault = value;
    },
  };
}

/** Collect every key path, with array members folded to [], so shapes compare without board contents. */
export function paths(value, prefix = '$', found = new Set()) {
  found.add(prefix);
  if (Array.isArray(value)) for (const member of value) paths(member, prefix + '[]', found);
  else if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) paths(child, prefix + '.' + name, found);
  return found;
}

/** Name the common scalar paths whose values differ between the two states, sampled by item and agent id. */
export function valueDifferences(native, relay) {
  const found = new Set();
  /** Compare two values below one path, matching array members by their id when they carry one. */
  function walk(left, right, path) {
    if (Array.isArray(left) && Array.isArray(right)) {
      const key = member => member && typeof member === 'object' ? member.id ?? member.agent_id ?? member.shout_id ?? null : null;
      const byKey = new Map(right.map(member => [key(member), member]));
      left.forEach((member, index) => {
        const other = key(member) === null ? right[index] : byKey.get(key(member));
        if (other !== undefined) walk(member, other, path + '[]');
      });
      return;
    }
    if (left && right && typeof left === 'object' && typeof right === 'object') {
      for (const name of Object.keys(left)) {
        if (Object.hasOwn(right, name) && !asOfField(path, name)) walk(left[name], right[name], path + '.' + name);
      }
      return;
    }
    if (JSON.stringify(left) !== JSON.stringify(right)) found.add(path);
  }
  walk(native, relay, '$');
  return [...found].sort();
}
