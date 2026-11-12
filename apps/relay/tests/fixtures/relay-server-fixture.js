/** The CLI-free relay half of the private relay fixtures: loopback relay, auth, GitHub provider, fault hooks and counters [H1,H7,H18]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAuthHandler } from '../../index.js';
import { createRelayAuth } from '../../index.js';
import { createRelayHandler } from '../../index.js';
import { createGitHubClient } from '../../index.js';
import { githubFixture } from '../../../cli/tests/fixtures/relay.js';
import { SEALED_SNAPSHOT_BYTES } from '../../../../packages/link/index.js';

/**
 * Start an authorized loopback relay with no CLI process. The caller owns the scratch folder (the relay keeps its journals and auth database there) and passes it in; it passes
 * beforeClose for any work that must finish before the relay stops (the client fixture stops its sender there).
 * The relay polls each live stream at its production 200 ms; a case that needs a faster poll passes pollMs by name.
 */
export async function relayServerFixture(t, { accountStorageBytes, pollMs = 200, host = '127.0.0.1', scratch, beforeClose } = {}) {
  const provider = await githubFixture(t);
  provider.state.deviceAuthorized = true;
  const authDatabase = join(scratch, 'auth.sqlite');
  let auth;
  let timeOffsetMs = 0;
  let override = null;
  let mintFailures = 0;
  let refuseEventReads = false;
  let refuseMoveSends = false;
  // Moves the relay auth clock alone, so a test can end a cached GitHub grant without expiring board records (#1013).
  let authOffsetMs = 0;
  let revokeOnNextListing = false;
  const boardsWithoutSnapshots = new Map();
  const injectedSnapshotWriteDelayMs = Number(process.env.PULLBOARD_TEST_SNAPSHOT_WRITE_DELAY_MS ?? 0);
  assert.ok(Number.isSafeInteger(injectedSnapshotWriteDelayMs) && injectedSnapshotWriteDelayMs >= 0 && injectedSnapshotWriteDelayMs <= 15000, // budget: declared snapshot-delay fixture input range is 0..15000ms; configuration validation, not throughput.
    'injected snapshot delay is within the product wait bound');
  let snapshotWriteDelayMs = 0;
  let oneSnapshotDelay = null;
  let snapshotWriteCount = 0;
  const pageWork = { pageUploadBytes: 0, pageSessions: 0, pageCheckpointAttempts: 0 };
  const snapshotWriteDelays = [];
  const snapshotWriteRecords = [];
  let stateReadDelayMs = 0;
  let stateReadHold = null;
  let stateReadStarted = 0;
  let refuseSnapshotWrites = false;
  let stallApi = false;
  let holdPublishes = false;
  const heldPublishes = [];
  let holdProbes = false;
  const heldProbes = [];
  let loseSnapshotReply = null;
  const lostSnapshotReplies = [];
  let rejectSnapshotWrites = null;
  let snapshotLimitBytes = null;
  const sizeRefusals = [];
  let rejectedStateReads = null;
  let legacySnapshotApi = false;
  let beforeSnapshotWrite = null;
  let refuseRequestWrites = false;
  let refuseBoardLinks = false;
  let refuseNextAcceptedApprovalCompletionResponse = false;
  let signIn;
  let api;
  let phone;
  let beforeMove;
  const calls = [];
  const transit = [];
  const responseWaiters = [];
  const moveAcks = [];
  const privateKeys = new Set();
  let nextConfirmationStatusHold = null;
  const confirmationStatusHolds = new Set();
  let keyLeaked = false;
  /** Wait until a named relay request has fully returned to its caller. */
  function waitForResponse(path) {
    const prior = transit.find(entry => entry.path.split('?')[0] === path);
    if (prior) return Promise.resolve(prior);
    return new Promise(resolveResponse => responseWaiters.push({ path, resolve: resolveResponse }));
  }
  /** Record one completed private HTTP exchange and wake matching deterministic fixture waiters. */
  function recordResponse(entry) {
    transit.push(entry);
    for (let index = responseWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = responseWaiters[index];
      if (entry.path.split('?')[0] === waiter.path) {
        responseWaiters.splice(index, 1);
        waiter.resolve(entry);
      }
    }
  }
  /** Hold one real confirmation-status request before the production auth handler for race tests. */
  function holdNextConfirmationStatus() {
    assert.equal(nextConfirmationStatusHold, null, 'only one confirmation-status hold is armed at a time');
    let resolveStarted;
    let resolveFinished;
    let resolveGate;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    const gate = new Promise(resolve => { resolveGate = resolve; });
    const control = { started, finished, gate, resolveStarted, resolveFinished, resolveGate, released: false };
    confirmationStatusHolds.add(control);
    /** Release the held request once so it can continue through the real auth handler. */
    function release() {
      if (control.released) return;
      control.released = true;
      control.resolveGate();
    }
    control.release = release;
    nextConfirmationStatusHold = control;
    return { started, finished, release };
  }
  const server = createServer(async (req, res) => {
    const snapshotWrite = req.method === 'PUT' && /\/api\/v1\/boards\/[0-9a-f]{32}\/state$/.test(req.url ?? '');
    if (snapshotWrite) snapshotWriteCount += 1;
    const pageObject = req.method === 'PUT' && /^\/api\/v2\/boards\/[0-9a-f]{32}\/uploads\/[^/]+\/objects\/[0-9a-f]{64}$/u.test(req.url ?? '');
    if (req.method === 'POST' && /^\/api\/v2\/boards\/[0-9a-f]{32}\/uploads$/u.test(req.url ?? '')) pageWork.pageSessions++;
    if (req.method === 'POST' && /^\/api\/v2\/boards\/[0-9a-f]{32}\/uploads\/[^/]+\/publish$/u.test(req.url ?? '')) pageWork.pageCheckpointAttempts++;

    const requestChunks = [];
    const responseChunks = [];
    const acceptedApprovalCompletionRefusal = refuseNextAcceptedApprovalCompletionResponse
      && req.method === 'POST'
      && /^\/api\/v1\/devices\/approvals\/[A-Za-z0-9_-]{1,80}\/complete$/u.test(req.url ?? '');
    if (acceptedApprovalCompletionRefusal) refuseNextAcceptedApprovalCompletionResponse = false;
    const snapshotStartedAt = Date.now();
    const snapshotRecord = snapshotWrite ? { at: snapshotStartedAt, sequence: null, ciphertext: null, status: null, elapsedMs: null, responseClosedBeforeFinish: false } : null;
    if (snapshotRecord) snapshotWriteRecords.push(snapshotRecord);
    const request = new Transform({
      transform(chunk, _encoding, callback) {
        requestChunks.push(Buffer.from(chunk));
        if (pageObject) pageWork.pageUploadBytes += chunk.byteLength;
        callback(null, chunk);
      },
    });
    Object.assign(request, { method: req.method, url: req.url, headers: req.headers });
    req.pipe(request);
    if (snapshotRecord) {
      request.once('finish', () => {
        let checkpoint = {};
        try { checkpoint = JSON.parse(Buffer.concat(requestChunks).toString('utf8')); } catch { /* Keep the transport trace safe when a malformed request arrives. */ }
        snapshotRecord.sequence = Number.isSafeInteger(checkpoint.sequence) ? checkpoint.sequence : null;
        snapshotRecord.ciphertext = typeof checkpoint.sealed === 'string' ? createHash('sha256').update(checkpoint.sealed).digest('hex') : null;
      });
      req.once('aborted', () => { snapshotRecord.requestAborted = true; });
      res.once('finish', () => {
        snapshotRecord.status = res.statusCode;
        snapshotRecord.elapsedMs = Date.now() - snapshotStartedAt;
      });
      res.once('close', () => {
        if (snapshotRecord.status === null) snapshotRecord.responseClosedBeforeFinish = true;
      });
    }
    /** Capture a response chunk for boolean-only transport audits without changing the response. */
    function captureResponse(chunk) {
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') responseChunks.push(Buffer.from(chunk));
    }
    const write = res.write.bind(res);
    res.write = (chunk, ...args) => { captureResponse(chunk); return write(chunk, ...args); };
    const writeHead = res.writeHead.bind(res);
    let acceptedApprovalCompletionReturnedAsRefusal = false;
    res.writeHead = (status, ...args) => {
      acceptedApprovalCompletionReturnedAsRefusal = acceptedApprovalCompletionRefusal && status === 200;
      return writeHead(acceptedApprovalCompletionReturnedAsRefusal ? 403 : status, ...args);
    };
    const end = res.end.bind(res);
    const loseThisReply = snapshotWrite && loseSnapshotReply;
    if (loseThisReply) loseSnapshotReply = null;
    res.end = (chunk, ...args) => {
      if (loseThisReply && res.statusCode === 200) {
        // The real service stored the snapshot; only its acknowledgement is lost on the wire (#919).
        lostSnapshotReplies.push(snapshotRecord.ciphertext);
        if (loseThisReply.thenStateReads) {
          rejectedStateReads = { ...loseThisReply.thenStateReads };
          const outage = rejectedStateReads;
          if (loseThisReply.recoverAfterMs !== undefined) {
            setTimeout(() => { if (rejectedStateReads === outage) rejectedStateReads = null; }, loseThisReply.recoverAfterMs).unref(); // budget: the outage the uncertain upload waits out.
          }
        }
        req.socket.destroy();
        return res;
      }
      if (acceptedApprovalCompletionReturnedAsRefusal) {
        chunk = JSON.stringify({ version: 1, error: { code: 'REVIEWER_COMPLETE_REFUSED',
          message: 'The completion response was refused after sealed delivery.',
          next: 'The completion response was refused after sealed delivery.' } });
      }
      captureResponse(chunk);
      if (req.method === 'POST' && /\/api\/v1\/boards\/[0-9a-f]{32}\/moves$/.test(req.url ?? '') && (typeof chunk === 'string' || Buffer.isBuffer(chunk))) {
        try {
          const response = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
          if (typeof response.event?.sealed === 'string') moveAcks.push(response.event);
        } catch { /* Capture only valid move acknowledgements; the production response remains unchanged. */ }
      }
      return end(chunk, ...args);
    };
    const call = { method: req.method, path: req.url, accept: req.headers.accept ?? '', engine: req.headers['x-pullboard-engine'],
      browser: String(req.headers.cookie ?? '').includes('pb_session=') };
    res.once('finish', () => {
      call.requestBytes = Buffer.concat(requestChunks).length; // What the client sent, for size bounds (#1014).
      recordResponse({ method: req.method, path: req.url, request: Buffer.concat(requestChunks), response: Buffer.concat(responseChunks) });
    });
    calls.push(call);
    if (stallApi && (req.url ?? '').startsWith('/api/')) { request.resume(); await new Promise(() => {}); }
    // A held API2 checkpoint publish waits until released, so a test can act while an upload is in flight (#1014).
    if (holdPublishes && req.method === 'POST' && /^\/api\/v2\/boards\/[0-9a-f]{32}\/uploads\/[^/]+\/publish$/u.test(req.url ?? '')) {
      await new Promise(release => heldPublishes.push(release));
    }
    // A held upload-pause probe waits too, so a test can move while the publisher asks whether a pause is over (#1014).
    if (holdProbes && req.method === 'GET' && /^\/api\/v2(?:\/boards\/[0-9a-f]{32}\/storage)?$/u.test(req.url ?? '')) {
      await new Promise(release => heldProbes.push(release));
    }
    if (legacySnapshotApi && req.method === 'GET' && req.url === '/api/v2') {
      res.writeHead(legacySnapshotApi === 'bad-route' ? 400 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(legacySnapshotApi === 'bad-route'
        ? { version: 1, error: { code: 'BAD_REQUEST', message: 'Use API1 on this legacy relay.' } }
        : { version: 1, apiVersion: 1, snapshot: 'legacy' }));
      request.resume(); return;
    }
    if (req.method === 'POST' && req.url === '/auth/device/confirmation/status' && nextConfirmationStatusHold) {
      const hold = nextConfirmationStatusHold;
      nextConfirmationStatusHold = null;
      hold.resolveStarted();
      /** Mark completion after the held request returns from the real auth handler. */
      function heldStatusFinished() {
        hold.resolveFinished({ status: res.statusCode, response: Buffer.concat(responseChunks) });
        confirmationStatusHolds.delete(hold);
      }
      res.once('finish', heldStatusFinished);
      await hold.gate;
    }
    if (revokeOnNextListing && req.method === 'GET' && req.url === '/api/v1/boards') {
      revokeOnNextListing = false;
      const session = await phoneSession();
      await auth.revoke(session.token, session.id);
    }
    if ([...privateKeys].some(key => JSON.stringify({ url: req.url, headers: req.headers }).includes(key))) keyLeaked = true;
    const missingSnapshot = /^\/api\/v1\/boards\/([0-9a-f]{32})\/(state|events)(?:\?|$)/u.exec(req.url ?? '');
    if (req.method === 'GET' && missingSnapshot && boardsWithoutSnapshots.get(missingSnapshot[1])?.has(missingSnapshot[2])) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: 'NO_BOARD', message: 'upload the sealed snapshot for this linked board first' } }));
      return;
    }
    if (rejectedStateReads && req.method === 'GET' && missingSnapshot?.[2] === 'state') {
      res.writeHead(rejectedStateReads.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: rejectedStateReads.version ?? 1,
        error: { code: rejectedStateReads.code, message: 'fixture uncertain remote state' } }));
      return;
    }
    if (mintFailures > 0 && req.method === 'POST' && req.url === '/auth/tokens') {
      mintFailures -= 1;
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: 'TEMPORARY', message: 'fixture refusal' } }));
      return;
    }
    if (refuseEventReads && req.method === 'GET' && /\/events(?:\?|$)/.test(req.url)) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: 'RELAY_UNAVAILABLE', message: 'fixture read outage' } }));
      return;
    }
    if (override && req.method === 'DELETE') {
      res.writeHead(override.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: override.version ?? 1, error: { code: override.code, message: 'fixture refusal' } }));
      return;
    }
    if (refuseRequestWrites && req.method === 'POST' && /\/api\/v1\/boards\/[0-9a-f]{32}\/requests$/.test(req.url ?? '')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: 'RELAY_UNAVAILABLE', message: 'fixture request outage' } }));
      return;
    }
    if (refuseBoardLinks && req.method === 'POST' && req.url === '/auth/boards/link') {
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: 'FIXTURE_LINK_REFUSED', message: 'fixture link sentinel' } }));
      return;
    }
    if (refuseSnapshotWrites && ((req.method === 'PUT' && /\/api\/v1\/boards\/[0-9a-f]{32}\/state$/.test(req.url ?? ''))
      || (req.method === 'POST' && /^\/api\/v2\/boards\/[0-9a-f]{32}\/uploads\/[A-Za-z0-9-]+\/publish$/u.test(req.url ?? '')))) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: 'RELAY_UNAVAILABLE', message: 'fixture snapshot outage' } }));
      return;
    }
    if (rejectSnapshotWrites && req.method === 'PUT' && /\/api\/v1\/boards\/[0-9a-f]{32}\/state$/.test(req.url ?? '')) {
      req.resume();
      res.writeHead(rejectSnapshotWrites.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: rejectSnapshotWrites.code, message: rejectSnapshotWrites.message } }));
      return;
    }
    // The next snapshot starts with an API1 state write or, for paged snapshots, the API2 upload session (#903).
    if (beforeSnapshotWrite && (snapshotWrite || (req.method === 'POST' && /^\/api\/v2\/boards\/[0-9a-f]{32}\/uploads$/u.test(req.url ?? '')))) {
      const before = beforeSnapshotWrite;
      beforeSnapshotWrite = null;
      await before(req.headers);
    }
    const stateSnapshotDelayMs = Math.max(snapshotWriteDelayMs, injectedSnapshotWriteDelayMs);
    if ((stateSnapshotDelayMs || oneSnapshotDelay?.count === snapshotWriteCount) && req.method === 'PUT' && /\/api\/v1\/boards\/[0-9a-f]{32}\/state$/.test(req.url ?? '')) {
      const delay = oneSnapshotDelay?.count === snapshotWriteCount ? oneSnapshotDelay.ms : stateSnapshotDelayMs;
      const delayedAt = Date.now();
      await new Promise(resolveDelay => setTimeout(resolveDelay, delay));
      snapshotWriteDelays.push(Date.now() - delayedAt);
    }
    if ((stateReadDelayMs || stateReadHold) && req.method === 'GET' && /\/api\/v1\/boards\/[0-9a-f]{32}\/state$/.test(req.url ?? '')) {
      stateReadStarted += 1;
      if (stateReadHold) await stateReadHold;
      else await new Promise(resolveDelay => setTimeout(resolveDelay, stateReadDelayMs));
    }
    // Checked before the move hook, so a hook that turns refusal on lets its own move through (#1013).
    if (refuseMoveSends && req.method === 'POST' && /\/api\/v1\/boards\/[0-9a-f]{32}\/moves$/.test(req.url ?? '')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: 'RELAY_UNAVAILABLE', message: 'fixture move outage' } }));
      request.resume(); return;
    }
    if (beforeMove && req.method === 'POST' && /\/api\/v1\/boards\/[0-9a-f]{32}\/moves$/.test(req.url ?? '')) {
      const action = beforeMove; beforeMove = null; await action();
    }
    if (await signIn(request, res)) return;
    let forwarded = request;
    if (snapshotWrite && snapshotLimitBytes !== null) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const value = JSON.parse(body.toString('utf8'));
      const sealedBytes = Buffer.from(value.sealed, 'base64url').byteLength;
      if (sealedBytes > snapshotLimitBytes) {
        const snapshotLimit = { sealedBytes, limit: snapshotLimitBytes };
        sizeRefusals.push({ board: req.url.split('/')[4], ...snapshotLimit });
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: 1, error: { code: 'BAD_UPLOAD',
          message: 'This sealed snapshot exceeds the configured upload limit; use bounded snapshots.', snapshotLimit } }));
        return;
      }
      forwarded = Object.assign(Readable.from([body]), { method: request.method, url: request.url, headers: request.headers });
    }
    await api(forwarded, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const relayPort = server.address().port;
  // A browser passkey needs a domain for its RP id, so a passkey case names the relay by `localhost` [E22].
  const origin = 'http://' + host + ':' + relayPort;
  auth = createRelayAuth({ database: authDatabase, github: createGitHubClient({ ...provider.config, callbackURL: origin + '/auth/github/callback' }), now: () => Date.now() + authOffsetMs });
  signIn = createAuthHandler({ auth, publicOrigin: origin });
  api = createRelayHandler({ directory: join(scratch, 'relay'), auth, publicOrigin: origin, pollMs, maintenanceMs: 0, accountStorageBytes, now: () => Date.now() + timeOffsetMs });
  /** Sign a separate phone in over actual OAuth HTTP; its person session stays only in fixture RAM. */
  async function phoneSession() {
    if (phone) return phone;
    const start = await fetch(origin + '/auth/github/start', { redirect: 'manual' });
    const binding = start.headers.getSetCookie().find(value => value.startsWith('pb_oauth_binding=')).split(';')[0];
    const approved = await fetch(start.headers.get('location'), { redirect: 'manual' });
    const callback = await fetch(approved.headers.get('location'), { redirect: 'manual', headers: { cookie: binding } });
    assert.equal(callback.status, 303, 'independent phone OAuth completes');
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('pb_session=')).split(';')[0];
    const token = cookie.slice('pb_session='.length);
    const principal = await auth.authenticate(token);
    phone = { token, id: principal.id };
    return phone;
  }
  t.after(async () => {
    nextConfirmationStatusHold = null;
    for (const hold of confirmationStatusHolds) hold.release();
    await beforeClose?.();
    api.close();
    server.closeAllConnections();
    if (server.listening) await new Promise(ready => server.close(ready));
    auth.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 150, retryDelay: 200 });
  });

  /** Stop the real relay listener and close active sockets to model a network outage. */
  async function stopRelay() {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise((ready, reject) => server.close(error => error ? reject(error) : ready()));
  }
  /** Restart the same relay listener at the same address without changing its journal or credentials. */
  async function restartRelay() {
    if (server.listening) return;
    await new Promise((ready, reject) => {
      const failed = error => { server.off('listening', ready); reject(error); };
      server.once('error', failed);
      server.once('listening', () => { server.off('error', failed); ready(); });
      server.listen(relayPort, '127.0.0.1');
    });
  }
  return {
    scratch, origin, auth, authDatabase, calls, transit, moveAcks, privateKeys, provider, pageWork, snapshotWriteLog: snapshotWriteRecords,
    snapshotWriteCountNow() { return snapshotWriteCount; },
    providerState: provider.state, providerCalls: provider.calls, providerOrigin: provider.origin, relayDirectory: join(scratch, 'relay'),
    waitForResponse, holdNextConfirmationStatus, phoneSession, stopRelay, restartRelay,
    /** Interleave one real authenticated relay write immediately before the next native move. */
    beforeNextMove(action) { beforeMove = action; },
    /** Move the relay clock by an explicit offset while preserving elapsed native wall time. */
    advance(days) { timeOffsetMs = days * 86400000; },
    overrideDelete(value) { override = value; },
    failTokenMints(count) { mintFailures = count; },
    /** Refuse the real API1 snapshot write or current API2 publish, preserving its pending client state. */
    refuseSnapshotWrites(value) { refuseSnapshotWrites = value; },
    /** Leave every board API request unanswered until its client times out, like an overloaded relay. */
    stallApi(value = true) { stallApi = value; },
    /** Hold every API2 checkpoint publish until called with false, which releases the held ones. */
    holdPublishes(value = true) {
      holdPublishes = value;
      if (!value) for (const release of heldPublishes.splice(0)) release();
    },
    /** How many API2 checkpoint publishes are being held. */
    heldPublishes() { return heldPublishes.length; },
    /** Hold every upload-pause probe (the API version and storage reads) until called with false. */
    holdProbes(value = true) {
      holdProbes = value;
      if (!value) for (const release of heldProbes.splice(0)) release();
    },
    /** How many upload-pause probes are being held. */
    heldProbes() { return heldProbes.length; },
    /**
     * Let the real relay accept the next API1 snapshot PUT, then drop its reply by closing the socket,
     * optionally answering later state reads with a chosen refusal, as the #919 lost-ACK review did.
     */
    loseNextSnapshotReply(options = {}) { loseSnapshotReply = { thenStateReads: options.thenStateReads ?? null, recoverAfterMs: options.recoverAfterMs }; },
    /** SHA-256 digests of the snapshots the relay accepted while their replies were lost. */
    lostSnapshotReplies() { return [...lostSnapshotReplies]; },
    /** Restart only the private service with a changed operator quota, retaining real journals and credentials. */
    setStorageQuota(bytes) {
      assert.ok(Number.isSafeInteger(bytes) && bytes > 0);
      api.close();
      api = createRelayHandler({ directory: join(scratch, 'relay'), auth, publicOrigin: origin, pollMs,
        maintenanceMs: 0, accountStorageBytes: bytes, now: () => Date.now() + timeOffsetMs });
    },
    /** Return a chosen HTTP refusal for snapshot writes, without inspecting the sealed body. */
    rejectSnapshots(value) { rejectSnapshotWrites = value ? { ...value } : null; },
    /** Enforce a real decoded-byte ceiling and report only sizes measured on the received upload. */
    limitSnapshots(bytes) {
      assert.ok(bytes === null || Number.isSafeInteger(bytes) && bytes > 0 && bytes <= SEALED_SNAPSHOT_BYTES);
      snapshotLimitBytes = bytes;
    },
    /** Return the bounded facts of actual rejected uploads, without retaining their sealed contents. */
    sizeRefusals() { return sizeRefusals.map(value => ({ ...value })); },
    /** Model an older relay's capability response without changing the real API1 request and journal bounds. */
    legacySnapshotApi(value = true) { legacySnapshotApi = value; },
    /** Order a competing real HTTP upload before the next native snapshot reaches the journal. */
    beforeNextSnapshot(value) { beforeSnapshotWrite = value; },
    /** Return a chosen real HTTP state refusal to exercise uncertain-baseline safety. */
    rejectStateReads(value) { rejectedStateReads = value ? { ...value } : null; },
    /** Delay each real relay snapshot upload until disabled to model late native checkpoints. */
    delaySnapshotWrites(ms) {
      assert.ok(Number.isSafeInteger(ms) && ms >= 0 && ms <= 15000, 'snapshot delay is within the product wait bound');
      snapshotWriteDelayMs = ms;
    },
    /** Delay exactly one upcoming PUT to exercise the real product abort and persisted retry. */
    delaySnapshotWriteOnce(offset, ms) {
      assert.ok(Number.isSafeInteger(offset) && offset > 0 && Number.isSafeInteger(ms) && ms > 10000 && ms <= 15000);
      oneSnapshotDelay = { count: snapshotWriteCount + offset, ms };
    },
    /** Return observed delays for the fixture's real snapshot endpoint. */
    snapshotWriteDelays() { return [...snapshotWriteDelays]; },
    /** Return sanitized per-child transport callsites and checkpoint fingerprints. */
    snapshotWriteRecords() { return snapshotWriteRecords.map(record => ({ ...record })); },
    /** Hold real state reads long enough to observe their pending-request diagnostic. */
    delayStateReads(ms) {
      assert.ok(Number.isSafeInteger(ms) && ms >= 0 && ms <= 30000, 'state read hold is bounded');
      stateReadDelayMs = ms;
    },
    /** Hold reads until the test explicitly releases them, avoiding load-sensitive short sleeps. */
    holdStateReads() {
      let release;
      stateReadHold = new Promise(resolveHold => { release = resolveHold; });
      return () => { stateReadHold = null; release(); };
    },
    /** Return how many state reads reached the private relay. */
    stateReadStarted() { return stateReadStarted; },
    refuseRequestWrites(value) { refuseRequestWrites = value; },
    /** Fail a surprise first-link request promptly so cancellation regressions cannot reach phone pairing. */
    refuseBoardLinks(value) { refuseBoardLinks = value; },
    /** Return HTTP 403 only after the real relay has stored one sealed approval completion. */
    refuseNextAcceptedApprovalCompletionResponse() { refuseNextAcceptedApprovalCompletionResponse = true; },
    keyInRequest() { return keyLeaked; },
    /** Revoke the actual synthetic person session, including its current live streams. */
    async revokeSession() { const session = await phoneSession(); return auth.revoke(session.token, session.id); },
    /** Revoke the real session when the next listing arrives so its HTTP authorization refusal is exercised. */
    revokeSessionOnNextListing() { revokeOnNextListing = true; },
    refuseReads(value) { refuseEventReads = value; },
    /** Answer every move send with a temporary outage, as a relay that stops taking moves part way (#1013). */
    refuseMoves(value) { refuseMoveSends = value; },
    /** Move the relay's auth clock forward by `ms`, past a cached GitHub grant's window (#1013). */
    advanceAuthorization(ms) { authOffsetMs += ms; },
    /** Return a selected listed-board read's missing-snapshot refusal over real HTTP. */
    noBoardOnReads(id, paths = ['state']) {
      boardsWithoutSnapshots.set(id, new Set(paths));
    },
  };
}
