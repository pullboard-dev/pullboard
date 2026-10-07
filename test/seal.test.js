/** Device-side sealing is the same bytes and WebCrypto code in Node and Chrome (H15, H17). */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeBoardKey, encodeBoardKey, generateBoardKey, seal, SEAL_VERSION, unseal } from '../src/seal.js';

const BOARD = '0123456789abcdef0123456789abcdef';
const TEXT = new TextEncoder().encode('A private board payload: \u03bb \ud83d\udd12');

/** A public binding, with overrides for the replay-refusal checks. */
function binding(overrides = {}) {
  return { boardId: BOARD, kind: 'move', sequence: 7, ...overrides };
}

/** Refusal assertions report only the code, never the supplied key or ciphertext. */
function refused(code) {
  return (error) => error?.name === 'Refused' && error.code === code;
}

test('board keys are random 256-bit values with canonical pairing fragments [H15,H17]', async () => {
  const first = await generateBoardKey();
  const second = await generateBoardKey();
  assert.equal(first.length, 32);
  assert.equal(second.length, 32);
  assert.ok(!first.every((value, index) => value === second[index]), 'fresh keys must differ');
  const encoded = encodeBoardKey(first);
  assert.match(encoded, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(first.every((value, index) => value === decodeBoardKey(encoded)[index]), 'pairing must recover the key');
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(encoded.at(-1));
  const alias = encoded.slice(0, -1) + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[last + 1];
  for (const invalid of ['', encoded + '=', alias, 'x'.repeat(42), 'x'.repeat(44), '#'+encoded, null]) {
    assert.throws(() => decodeBoardKey(invalid), refused('SEAL_KEY'));
  }
  assert.throws(() => encodeBoardKey(new Uint8Array(31)), refused('SEAL_KEY'));
});

test('each sealed kind has a version, fresh 96-bit nonce and full GCM tag [H15,H17]', async () => {
  const key = await generateBoardKey();
  const nonces = new Set();
  for (const kind of ['snapshot', 'move', 'request']) {
    for (const plain of [new Uint8Array(), TEXT, Uint8Array.from({ length: 256 }, (_, index) => index)]) {
      const where = binding({ kind, sequence: kind === 'snapshot' ? 0 : 7 });
      const blob = await seal(key, plain, where);
      assert.equal(blob[0], SEAL_VERSION);
      assert.equal(blob.length, 1 + 12 + plain.length + 16);
      const nonce = [...blob.slice(1, 13)].join(',');
      assert.ok(!nonces.has(nonce), 'a new blob needs a fresh nonce');
      nonces.add(nonce);
      assert.deepEqual(await unseal(key, blob, where), plain);
    }
  }
});

test('unsealing refuses wrong keys, every changed payload byte and every wrong binding [H15,H17]', async () => {
  const key = await generateBoardKey();
  const blob = await seal(key, TEXT, binding());
  await assert.rejects(unseal(await generateBoardKey(), blob, binding()), refused('SEAL_AUTH_FAILED'));
  for (let index = 1; index < blob.length; index++) {
    const changed = new Uint8Array(blob);
    changed[index] ^= 1;
    await assert.rejects(unseal(key, changed, binding()), refused('SEAL_AUTH_FAILED'));
  }
  for (const where of [binding({ boardId: BOARD + 'a' }), binding({ kind: 'request' }),
    binding({ kind: 'snapshot' }), binding({ sequence: 8 }), binding({ sequence: 0 })]) {
    await assert.rejects(unseal(key, blob, where), refused('SEAL_AUTH_FAILED'));
  }
  const future = new Uint8Array(blob);
  future[0] = 2;
  await assert.rejects(unseal(key, future, binding()), refused('SEAL_VERSION'));
  for (const truncated of [new Uint8Array(), blob.slice(0, 1), blob.slice(0, 28)]) {
    await assert.rejects(unseal(key, truncated, binding()), refused('SEAL_FORMAT'));
  }
});

test('sealing validates inputs and copies mutable buffers and binding before awaiting [H15,H17]', async () => {
  const key = await generateBoardKey();
  for (const where of [null, binding({ boardId: '' }), binding({ kind: 'other' }),
    binding({ sequence: -1 }), binding({ sequence: 1.5 }), binding({ sequence: Number.MAX_SAFE_INTEGER + 1 })]) {
    await assert.rejects(seal(key, TEXT, where), refused('SEAL_BINDING'));
  }
  await assert.rejects(seal(new Uint8Array(16), TEXT, binding()), refused('SEAL_KEY'));
  await assert.rejects(seal(key, 'text', binding()), refused('SEAL_DATA'));
  const detached = new Uint8Array(32);
  structuredClone(detached, { transfer: [detached.buffer] });
  await assert.rejects(seal(detached, TEXT, binding()), refused('SEAL_KEY'));
  const mutableKey = new Uint8Array(key);
  const mutablePlain = new Uint8Array(TEXT);
  const where = binding();
  const pending = seal(mutableKey, mutablePlain, where);
  mutableKey.fill(0); mutablePlain.fill(0); where.sequence++;
  const blob = await pending;
  assert.deepEqual(await unseal(key, blob, binding()), TEXT);
  const mutableBlob = new Uint8Array(blob);
  const decoding = unseal(key, mutableBlob, binding());
  mutableBlob.fill(0);
  assert.deepEqual(await decoding, TEXT);
});

/** Find an installed browser, with an explicit override for other supported host layouts. */
function chromeExecutable() {
  return [process.env.PULLBOARD_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((path) => path && existsSync(path));
}

/** Await a browser callback, then stop only our isolated process group, without exposing output. */
async function chromeRun(executable, url, profile, resultReady) {
  // Use the temporary profile and mock keychain; the test must never reach a person's credentials.
  const child = spawn(executable, ['--headless', '--disable-gpu', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-extensions', '--no-proxy-server', '--use-mock-keychain',
    '--password-store=basic', url],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  child.stderr.resume();
  let timer;
  const stopped = new Promise((resolve) => child.once('close', resolve));
  try {
    await Promise.race([resultReady, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Isolated Chrome did not report within 30 seconds.')), 30_000);
      child.once('error', () => reject(new Error('Isolated Chrome could not start.')));
      child.once('close', () => reject(new Error('Isolated Chrome exited before its interoperability result.')));
    })]);
  } finally {
    clearTimeout(timer);
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Our process group already exited. */ }
    }
    let cleanupTimer;
    const exited = await Promise.race([stopped.then(() => true), new Promise((resolve) => {
      cleanupTimer = setTimeout(() => resolve(false), 5000);
    })]);
    clearTimeout(cleanupTimer);
    if (!exited && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Our process group already exited. */ }
    }
    await stopped;
  }
}

test('headless Chrome loads the unchanged module and exchanges sealed bytes with Node [H15,H17]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the browser interoperability proof.');
  const key = await generateBoardKey();
  const fixtures = [];
  for (const kind of ['snapshot', 'move', 'request']) {
    const where = binding({ kind });
    fixtures.push({ binding: where, blob: [...await seal(key, TEXT, where)] });
  }
  let browserResult;
  const requests = new Set();
  let reportReady;
  const resultReady = new Promise((resolve) => { reportReady = resolve; });
  const html = '<!doctype html><body data-seal-result="pending"><script type="module">' +
    'import {decodeBoardKey,seal,unseal} from "/seal.js";' +
    'try {const f=await (await fetch("/fixture")).json();const key=decodeBoardKey(f.key);const replies=[];' +
    'for(const entry of f.entries){const plain=await unseal(key,new Uint8Array(entry.blob),entry.binding);' +
    'replies.push({plain:[...plain],blob:[...await seal(key,plain,entry.binding)]});}' +
    'await fetch("/result",{method:"POST",body:JSON.stringify(replies)});document.body.dataset.sealResult="pass";' +
    '}catch{document.body.dataset.sealResult="fail";}</script>';
  const server = createServer((req, res) => {
    if (['/', '/seal.js', '/refused.js', '/fixture', '/result'].includes(req.url)) requests.add(req.url);
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html);
    }
    if (['/seal.js', '/refused.js'].includes(req.url) && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      return res.end(readFileSync(new URL('../src' + req.url, import.meta.url)));
    }
    if (req.url === '/fixture' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ key: encodeBoardKey(key), entries: fixtures }));
    }
    if (req.url === '/result' && req.method === 'POST') {
      let body = '';
      req.on('data', (part) => { body += part; });
      req.on('end', () => { try { browserResult = JSON.parse(body); } catch { browserResult = null; } res.end('{}'); reportReady(); });
      return;
    }
    res.writeHead(404); res.end();
  });
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-seal-chrome-'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await chromeRun(executable, 'http://127.0.0.1:' + server.address().port + '/', profile, resultReady);
    } catch {
      assert.fail('Chrome interoperability failed; requested fixture routes: ' + [...requests].sort().join(', '));
    }
    assert.equal(browserResult?.length, 3, 'Chrome must return all three sealed kinds');
    for (let index = 0; index < fixtures.length; index++) {
      assert.deepEqual(new Uint8Array(browserResult[index].plain), TEXT);
      assert.deepEqual(await unseal(key, new Uint8Array(browserResult[index].blob), fixtures[index].binding), TEXT);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});
