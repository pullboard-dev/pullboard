// pullboard: browser
/** @pullboard-test-gui */
/** The view's main journeys as real-input scenarios in Chrome [N26], and the two-home hosted journey through the real view, relay, browser client and item API [N40]. */

import assert from 'node:assert/strict';
import {
  randomUUID,
} from 'node:crypto';
import {
  createServer,
  request,
} from 'node:http';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  project,
  openSnapshotChrome,
  closeSnapshotChrome,
  chromeExecutable,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  waitFor,
  journeyRefusalBody,
  journeyAuthTrace,
  failJourneyRows,
} from '../../../tests/fixtures/cockpit/journey/every.js';

test('auth diagnostics tolerate malformed refusals and preserve the original row error [N40]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for actual HTTP auth diagnostics.');
  const marker = 'fixture-' + randomUUID();
  const privateCode = 'PRIVATE_' + randomUUID().slice(0, 8).toUpperCase();
  const cases = new Map([
    ['valid', { status: 401, body: JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'sign in to the relay in this browser' } }), code: 'AUTH_REQUIRED', kind: 'cookie-not-a-session' }],
    ['forbidden', { status: 403, body: JSON.stringify({ error: { code: 'BAD_ORIGIN', message: 'send cookie-authorized writes from the relay origin' } }), code: 'BAD_ORIGIN', kind: 'other' }],
    ['invalid', { status: 401, contentType: 'text/html', body: '<html>' + marker + '</html>', code: 'invalid', kind: 'invalid' }],
    ['unknown', { status: 401, body: JSON.stringify({ error: { code: privateCode, message: marker } }), code: 'other', kind: 'other' }],
    // The shared API's own 403 keeps its public code (#825 review), and a refusal whose body never arrives is still counted.
    ['api-origin', { status: 403, body: JSON.stringify({ error: { code: 'API_ORIGIN', message: 'this view answers only its own page' } }), code: 'API_ORIGIN', kind: 'other' }],
    ['interrupted', { status: 401, interrupt: true, body: '{"error":{"code":"AUTH_REQUIRED","mess', code: 'unread', kind: 'interrupted' }],
  ]);
  const cookieArrivals = [];
  const server = createServer((req, res) => {
    const address = new URL(req.url, 'http://127.0.0.1');
    if (address.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Owned diagnostic fixture</title><main>Diagnostic fixture</main>');
      return;
    }
    const entry = cases.get(address.searchParams.get('case'));
    if (!entry) { res.writeHead(404); res.end(); return; }
    cookieArrivals.push((req.headers.cookie ?? '').split(';').some(part => part.trim() === 'pb_session=' + marker));
    res.writeHead(entry.status, { 'Content-Type': entry.contentType ?? 'application/json', 'Cache-Control': 'no-store', ...(entry.interrupt ? { 'Content-Length': '4096' } : {}) });
    if (entry.interrupt) { res.write(entry.body); setTimeout(() => res.destroy(), 50); return; } // budget: lets the headers and first bytes reach Chrome before the connection drops; no throughput claim.
    res.end(entry.body);
  });
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-journey-auth-trace-'));
  let chrome;
  let trace;
  try {
    await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    chrome = await openSnapshotChrome(executable, origin + '/', profile);
    const planted = await chrome.send('Network.setCookie', { name: 'pb_session', value: marker, url: origin + '/', httpOnly: true, sameSite: 'Lax' });
    assert.equal(planted.success, true, 'the isolated browser holds its own synthetic cookie');
    trace = journeyAuthTrace(chrome, origin);
    trace.begin();
    for (const [name, entry] of cases) {
      const path = '/api/v1/boards/' + marker + '/state?case=' + name + '&private=' + marker;
      const status = await chrome.stable(`(async () => {
        const response = await fetch(${JSON.stringify(path)}, { credentials: 'include' });
        try { await response.text(); } catch { /* the interrupted case's body never completes */ }
        return response.status;
      })()`);
      assert.equal(status, entry.status, 'the actual browser fetch returned the HTTP refusal status');
    }
    let report;
    const deadline = Date.now() + 10_000;
    do { report = await trace.read(); } while (report.refusals.length < cases.size && Date.now() < deadline);
    const project = ({ status, code, kind, pathKind }) => ({ status, code, kind, pathKind });
    const order = (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right));
    assert.deepEqual(report.refusals.map(project).sort(order), [...cases.values()].map(({ status, code, kind }) =>
      ({ status, code, kind, pathKind: '/api/v1/boards/:id/state' })).sort(order));
    assert.deepEqual(cookieArrivals, [...cases.keys()].map(() => true), 'real HTTP requests carried the isolated cookie');
    assert.ok(!JSON.stringify(report).includes(marker), 'no body, cookie value or URL identifier enters the trace');
    assert.ok(!JSON.stringify(report).includes(privateCode), 'unknown uppercase response codes are redacted');
    assert.equal(report.cookies.length, 1, 'the actual browser cookie attributes remain observable');
    assert.equal(report.cookies[0].httpOnly, true);
    let originalError;
    try { await chrome.waitFor("document.querySelector('#row-that-never-arrives')", 250); } // budget: declared missing-row fault and hang ceiling, caught to test diagnostics; no throughput promise.
    catch (error) { originalError = error; }
    assert.ok(originalError, 'the real browser row wait fails in the controlled fixture');
    const diagnostics = [];
    await assert.rejects(() => failJourneyRows({ diagnostic(line) { diagnostics.push(line); t.diagnostic(line); } },
      { error: originalError, report: { controlledMissingRow: true } }, trace),
    error => error === originalError, 'the actual reporting path rethrows the exact original row failure');
    assert.ok(diagnostics.some(line => line.startsWith('auth trace ')), 'the controlled row failure prints the trace');
    assert.ok(!diagnostics.join('\n').includes(marker), 'printed diagnostics contain no private fixture values');
  } finally {
    try { trace?.close(); if (chrome) await closeSnapshotChrome(chrome); }
    finally {
      try { server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done)); }
      finally { rmSync(profile, { recursive: true, force: true }); }
    }
  }
});

test('auth trace retains a completed refusal while its body delivery is pending [N40]', { timeout: 60_000 }, async () => { // budget: hang ceiling for owned Chrome and deferred CDP delivery cleanup.
  const marker = 'owned-' + randomUUID();
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/' ? 200 : 401, { 'Content-Type': req.url === '/' ? 'text/html' : 'application/json' });
    res.end(req.url === '/' ? '<title>Owned trace delivery</title>' : JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'this credential is expired or revoked ' + marker } }));
  });
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-auth-delivery-'));
  let chrome;
  let trace;
  let releaseBody;
  const heldBody = new Promise(resolve => { releaseBody = resolve; });
  let bodyRequested;
  const requested = new Promise(resolve => { bodyRequested = resolve; });
  let requestTimer;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    chrome = await openSnapshotChrome(chromeExecutable(), origin + '/', profile);
    const send = chrome.send;
    chrome.send = async (method, params) => {
      const result = await send(method, params);
      if (method === 'Network.getResponseBody') { bodyRequested(); await heldBody; }
      return result;
    };
    trace = journeyAuthTrace(chrome, origin);
    trace.begin();
    const status = await chrome.stable(`(async () => { const r = await fetch('/api/v1/boards/${marker}/state'); await r.text(); return r.status; })()`);
    assert.equal(status, 401, 'real Chrome received the completed HTTP refusal');
    await Promise.race([requested, new Promise((resolve, reject) => { requestTimer = setTimeout(() => reject(new Error('owned CDP body request missing')), 5_000); })]); // budget: hang ceiling for observing the actual finished response event.
    clearTimeout(requestTimer);
    const pending = await trace.read();
    assert.equal(pending.refusals.length, 1, 'an observed 401 remains present across the existing body-read ceiling');
    assert.equal(pending.refusals[0].status, 401);
    assert.equal(pending.refusals[0].code, 'pending');
    releaseBody();
    const decoded = await trace.read();
    assert.equal(decoded.refusals.length, 1, 'late delivery replaces the pending category without duplicating the response');
    assert.equal(decoded.refusals[0].code, 'AUTH_REQUIRED');
    assert.equal(decoded.refusals[0].kind, 'session-expired-or-revoked');
    assert.equal(pending.refusals[0].code, 'pending', 'a previously returned report stays a snapshot');
    assert.equal((await trace.read()).refusals.length, 1, 'repeat reads do not duplicate the response');
    assert.ok(!JSON.stringify([pending, decoded]).includes(marker), 'no URL identifier or response text is retained');
  } finally {
    clearTimeout(requestTimer);
    releaseBody();
    try { trace?.close(); if (chrome) await closeSnapshotChrome(chrome); }
    finally {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      rmSync(profile, { recursive: true, force: true });
    }
  }
});

test('auth refusal protocol bodies decode without exposing invalid payloads [N40]', () => {
  const value = JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'this credential is expired or revoked' } });
  const expected = { code: 'AUTH_REQUIRED', kind: 'session-expired-or-revoked' };
  assert.deepEqual(journeyRefusalBody({ body: value }), expected);
  assert.deepEqual(journeyRefusalBody({ body: Buffer.from(value).toString('base64'), base64Encoded: true }), expected);
  for (const body of ['not JSON', '[]', 'null', '{}']) {
    assert.deepEqual(journeyRefusalBody({ body }), { code: 'invalid', kind: 'invalid' });
  }
  assert.deepEqual(journeyRefusalBody(undefined), { code: 'invalid', kind: 'invalid' });
});
