import { commandPhaseSnapshot } from '../src/command-phase.js';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../src/person.js';
/** Private real CLI, auth and relay fixture; credentials never enter assertion messages [H1,H7,H18]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startFixtureChild as spawn, reportFixtureChildFailure, runFixtureChild } from './fixture-child.js';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createAuthHandler } from '../relay/auth-http.js';
import { createRelayAuth } from '../relay/auth.js';
import { createRelayHandler } from '../relay/service.js';
import { createGitHubClient } from '../relay/github.js';
import { githubFixture } from './relay-fixture.js';
import { relayWorkBudgetMs, MAX_SNAPSHOT_ATTEMPTS } from './relay-budget.js';
import { SEALED_SNAPSHOT_BYTES } from '../src/relay-limits.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');
const MAX_OBSERVED_SNAPSHOT_UPLOADS = MAX_SNAPSHOT_ATTEMPTS;
const DEFAULT_SNAPSHOT_UPLOADS = 3;
// One former whole-snapshot wire allowance is a finite unit of observed API2 transfer work too.
const PAGE_WORK_BYTES = 10_000_000;

/** Keep legacy attempts exact while counting received API2 wire bytes and checkpoint attempts, never elapsed activity. */
function uploadWork(value) {
  const work = typeof value === 'number' ? { legacyUploads: value } : value;
  const result = Object.fromEntries(['legacyUploads', 'pageUploadBytes', 'pageSessions', 'pageCheckpointAttempts'].map(key => [key, work?.[key] ?? 0]));
  assert.ok(Object.values(result).every(number => Number.isSafeInteger(number) && number >= 0), 'fixture upload work has bounded integer counters');
  result.units = result.legacyUploads + Math.max(result.pageSessions, result.pageCheckpointAttempts) + Math.ceil(result.pageUploadBytes / PAGE_WORK_BYTES);
  // Attempt and byte ceilings are independent: bytes do not consume a checkpoint attempt. Time still has the released six-unit cap.
  result.budgetUnits = Math.min(result.units, MAX_OBSERVED_SNAPSHOT_UPLOADS);
  result.overLimit = result.legacyUploads > MAX_OBSERVED_SNAPSHOT_UPLOADS || result.pageSessions > MAX_OBSERVED_SNAPSHOT_UPLOADS
    || result.pageCheckpointAttempts > MAX_OBSERVED_SNAPSHOT_UPLOADS || result.pageUploadBytes > PAGE_WORK_BYTES * MAX_OBSERVED_SNAPSHOT_UPLOADS;
  return result;
}


/** Derive a private CLI child deadline from observed uploads, with a finite runaway guard. */
export function cliChildDeadlineMs(observedUploads) {
  assert.ok(Number.isSafeInteger(observedUploads) && observedUploads >= 0 && observedUploads <= MAX_OBSERVED_SNAPSHOT_UPLOADS,
    'observed snapshot upload count is within the finite fixture bound');
  return relayWorkBudgetMs(observedUploads);
}

/** Count exact checkpoints; a newer acknowledged snapshot may cover a superseded timeout. */
export function assertSnapshotCheckpoints(trace, expected) {
  try {
    const checkpoints = new Map();
    let priorSequence = -1;
    for (const write of trace) {
      assert.ok(Number.isSafeInteger(write.sequence) && /^[0-9a-f]{64}$/u.test(write.ciphertext ?? ''), 'checkpoint metadata is complete');
      assert.ok(write.sequence >= priorSequence, 'checkpoint attempts never regress the covered sequence');
      priorSequence = write.sequence;
      const previous = checkpoints.get(write.sequence);
      if (previous) {
        assert.equal(write.ciphertext, previous.ciphertext, 'a retried sequence preserves its exact ciphertext');
        assert.equal(previous.abort?.name, 'TimeoutError', 'only a timed-out PUT can add a transport attempt');
        // Bind the exported retry function, independent of its source module or namespace.
        assert.ok(write.callers.some(caller => caller.split('@', 1)[0].replace(/^async /u, '').split('.').at(-1) === 'retrySync'),
          'syncRelay retries the persisted checkpoint');
      }
      checkpoints.set(write.sequence, write);
    }
    assert.equal(checkpoints.size, expected, 'the flow publishes its exact number of distinct checkpoints');
    if (expected === 0) return checkpoints.size;
    const latest = trace.at(-1);
    assert.equal(latest?.status, 200, 'the latest checkpoint receives an acknowledgement');
    for (const write of checkpoints.values()) {
      if (write.status === 200) continue;
      assert.equal(write.abort?.name, 'TimeoutError', 'only a timed-out checkpoint can be superseded');
      assert.ok(latest.sequence > write.sequence, 'the acknowledged checkpoint covers the superseded sequence');
    }
    return checkpoints.size;
  } catch (error) {
    error.message += '; sanitized checkpoint fetches: ' + JSON.stringify(trace);
    throw error;
  }
}

/** Capture a real child result without exposing its private output in failure diagnostics. */
function childResult(root, env, argv, observedSnapshotUploads, initialSnapshotUploads = DEFAULT_SNAPSHOT_UPLOADS) {
  return new Promise((resolveResult, reject) => {
    const startedAt = performance.now();
    let deadlineMs = cliChildDeadlineMs(initialSnapshotUploads);
    let work = uploadWork(initialSnapshotUploads);
    const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let exceededDeadline = false;
    let exceededWork = false;
    let settled = false;
    const timer = setInterval(() => {
      work = uploadWork(observedSnapshotUploads?.() ?? initialSnapshotUploads);
      if (work.overLimit) {
        exceededWork = true;
        child.kill('SIGKILL');
        return;
      }
      deadlineMs = Math.max(deadlineMs, cliChildDeadlineMs(work.budgetUnits));
      if (performance.now() - startedAt >= deadlineMs) { exceededDeadline = true; child.kill('SIGKILL'); }
    }, 20);
    child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
    /** Retain the exact command and work-derived bound without exposing credentials. */
    const reportFailure = (code, signal, detail = '') => reportFixtureChildFailure({
      command: process.execPath, args: argv, status: code, signal,
      elapsedMs: performance.now() - startedAt, stderr, env, detail: exceededDeadline
        ? detail + '\nstall phase capture: ' + JSON.stringify(commandPhaseSnapshot(env.PULLBOARD_COMMAND_PHASE_FILE, child.pid)) : detail,
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      reject(new Error(reportFailure(null, null, error.message)));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      const phase = work.pageUploadBytes > 0 ? 'API2 page upload' : work.pageSessions || work.pageCheckpointAttempts ? 'API2 checkpoint' : 'snapshot upload';
      if (signal) return reject(new Error(reportFailure(code, signal, exceededWork
        ? `declared upload work limit exceeded: at most ${MAX_OBSERVED_SNAPSHOT_UPLOADS} attempts and ${PAGE_WORK_BYTES * MAX_OBSERVED_SNAPSHOT_UPLOADS} page bytes; recorded work ${JSON.stringify(work)}`
        : exceededDeadline ? `${phase} stalled: upload-derived child deadline ${deadlineMs}ms exceeded; recorded work ${JSON.stringify(work)}` : '')));
      const failure = code === 0 ? null : reportFailure(code, signal);
      let document;
      try { document = JSON.parse(stdout); }
      catch (error) { return reject(new Error(reportFailure(code, signal, `private relay fixture child did not return JSON: ${error.message}`))); }
      work = uploadWork(observedSnapshotUploads?.() ?? initialSnapshotUploads);
      resolveResult({ code, document, failure, snapshotUploads: work.legacyUploads,
        snapshotWork: { ...work, observed: typeof observedSnapshotUploads === 'function' }, snapshotDeadlineMs: deadlineMs });
    });
  });
}

export { childResult as relayFixtureChild };

/**
 * Start an isolated board and authorized loopback relay; a null coordinatorModel keeps its initial identity unknown.
 * The relay polls each live stream at its production 200 ms. Each poll opens the board journals, and at the 10 ms this
 * fixture once used, a loaded machine kept the test process busy enough that browser replies queued past their
 * deadlines (#955, #979). A case that needs a faster poll passes pollMs by name and says why.
 */
export async function relayClientFixture(t, { cliChildren, coordinatorModel, accountStorageBytes, pollMs = 200 } = {}) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-relay-cleanup-')));
  const root = join(scratch, 'repo');
  const home = join(scratch, 'home');
  const privateBin = join(scratch, 'path');
  const traceFile = join(scratch, 'snapshot-fetch-trace.jsonl');
  const tracePreload = join(scratch, 'snapshot-fetch-trace.mjs');
  mkdirSync(root);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(privateBin, { mode: 0o700 });
  const git = process.env.PATH.split(delimiter).map(entry => join(entry, 'git')).find(existsSync);
  assert.ok(git, 'fixture has a git executable');
  symlinkSync(realpathSync(git), join(privateBin, 'git'));
  symlinkSync(realpathSync(process.execPath), join(privateBin, 'node'));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'),
    PULLBOARD_MACHINE_HOME: join(scratch, 'machine'), PATH: privateBin,
    TERM_SESSION_ID: createHash('sha256').update(scratch).digest('hex'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Relay Fixture', GIT_AUTHOR_EMAIL: 'relay-fixture@example.com',
    GIT_COMMITTER_NAME: 'Relay Fixture', GIT_COMMITTER_EMAIL: 'relay-fixture@example.com',
  };
  if (coordinatorModel === null) delete env.PULLBOARD_MODEL;
  else if (coordinatorModel !== undefined) env.PULLBOARD_MODEL = coordinatorModel;
  writeFileSync(tracePreload, `
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const originalFetch = globalThis.fetch;
/** Record safe request, caller and checkpoint details for this private relay only. */
globalThis.fetch = function tracedFetch(input, init) {
  const target = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
  const method = init?.method ?? input?.method ?? 'GET';
  if (target.origin !== process.env.PULLBOARD_TEST_RELAY_TRACE_ORIGIN || method !== 'PUT'
      || !/^\\/api\\/v1\\/boards\\/[0-9a-f]{32}\\/state$/u.test(target.pathname)) {
    return originalFetch.call(this, input, init);
  }
  const startedAt = Date.now();
  const body = init?.body;
  let sequence = null;
  let ciphertext = null;
  try {
    const document = JSON.parse(String(body));
    if (Number.isSafeInteger(document.sequence)) sequence = document.sequence;
    if (typeof document.sealed === 'string') ciphertext = createHash('sha256').update(document.sealed).digest('hex');
  } catch { /* Record only metadata for malformed fixture traffic. */ }
  const callers = (new Error().stack ?? '').split('\\n')
    .filter(line => line.includes('/src/'))
    .slice(0, 8)
    .map(line => {
      const name = line.match(/^\\s*at (.*?) \\(/u)?.[1] ?? '<anonymous>';
      const location = line.match(/\\/src\\/([^/():]+\\.js:\\d+:\\d+)/u)?.[1] ?? 'unknown';
      return name + '@' + location;
    });
  const signal = init?.signal ?? input?.signal;
  let abort = signal?.aborted ? { at: Date.now(), name: signal.reason?.name ?? null, code: signal.reason?.code ?? null } : null;
  const onAbort = () => { abort = { at: Date.now(), name: signal.reason?.name ?? null, code: signal.reason?.code ?? null }; };
  signal?.addEventListener('abort', onAbort, { once: true });
  const record = { at: startedAt, method, path: target.pathname.replace(/\\/[0-9a-f]{32}\\//u, '/<board>/'), sequence, ciphertext, callers };
  /** Persist one bounded request outcome while excluding the sealed payload and credentials. */
  function finish(details) {
    appendFileSync(process.env.PULLBOARD_TEST_RELAY_TRACE_FILE, JSON.stringify({ ...record, abort, ...details }) + '\\n', { mode: 0o600 });
    signal?.removeEventListener('abort', onAbort);
  }
  return originalFetch.call(this, input, init).then(response => {
    finish({ status: response.status, elapsedMs: Date.now() - startedAt });
    return response;
  }, error => {
    finish({ errorName: error.name, errorCode: error.code ?? null, elapsedMs: Date.now() - startedAt });
    throw error;
  });
};
`, { mode: 0o600 });
  writeFileSync(traceFile, '', { mode: 0o600 });
  for (const name of ['PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN', ...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[name];
  const provider = await githubFixture(t);
  provider.state.deviceAuthorized = true;
  const authDatabase = join(scratch, 'auth.sqlite');
  let auth;
  let timeOffsetMs = 0;
  let override = null;
  let mintFailures = 0;
  let refuseEventReads = false;
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
        if (loseThisReply.thenStateReads) rejectedStateReads = { ...loseThisReply.thenStateReads };
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
    if (refuseSnapshotWrites && req.method === 'PUT' && /\/api\/v1\/boards\/[0-9a-f]{32}\/state$/.test(req.url ?? '')) {
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
  const origin = 'http://127.0.0.1:' + relayPort;
  auth = createRelayAuth({ database: authDatabase, github: createGitHubClient({ ...provider.config, callbackURL: origin + '/auth/github/callback' }) });
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
    api.close();
    server.closeAllConnections();
    if (server.listening) await new Promise(ready => server.close(ready));
    auth.close();
    rmSync(scratch, { recursive: true, force: true });
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
  /** Invoke the production CLI in this private repository. */
  let cliChildIndex = 0;
  let phaseSequence = 0;
  /** Verify and consume the next optional test-flow child descriptor. */
  function plannedSnapshotUploads(args) {
    if (!cliChildren) return undefined;
    const step = cliChildren[cliChildIndex++];
    assert.ok(step, `unexpected private CLI child: ${args.slice(0, 2).join(' ')}`);
    assert.deepEqual(args.slice(0, step.command.length), step.command, `private CLI child ${cliChildIndex} matches its budget descriptor`);
    return step.snapshotUploads;
  }
  /** Run one CLI child and verify its observed uploads against the plan when the test supplied one. */
  async function runCliChild(args, requestedUploads, traceSnapshotWrites = false) {
    const plannedUploads = plannedSnapshotUploads(args);
    const snapshotUploads = plannedUploads ?? requestedUploads;
    const writesBefore = snapshotWriteCount;
    const pagesBefore = { ...pageWork };
    /** Observe only this child's received work; retries consume the same finite six-unit allowance. */
    const observedWork = () => ({ legacyUploads: snapshotWriteCount - writesBefore,
      ...Object.fromEntries(Object.entries(pageWork).map(([name, count]) => [name, count - pagesBefore[name]])) });
    const phaseEnv = { ...env, PULLBOARD_COMMAND_PHASE_FILE: join(scratch, `command-phase-${++phaseSequence}.jsonl`) };
    const childEnv = traceSnapshotWrites ? { ...phaseEnv, PULLBOARD_TEST_RELAY_TRACE_FILE: traceFile,
      PULLBOARD_TEST_RELAY_TRACE_ORIGIN: origin,
      NODE_OPTIONS: [env.NODE_OPTIONS, '--import=' + pathToFileURL(tracePreload).href].filter(Boolean).join(' ') } : phaseEnv;
    const traceLinesBefore = traceSnapshotWrites ? readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).length : 0;
    const initialUploads = traceSnapshotWrites ? 0 : snapshotUploads ?? DEFAULT_SNAPSHOT_UPLOADS;
    /** Read only this child’s sanitized fetch records, retaining evidence before fixture cleanup. */
    function childTrace() {
      if (!traceSnapshotWrites) return [];
      return readFileSync(traceFile, 'utf8').split('\n').filter(Boolean)
        .slice(traceLinesBefore).map(line => JSON.parse(line));
    }
    let result;
    try {
      result = await childResult(root, childEnv, [CLI, ...args, '--json'], observedWork, initialUploads);
    } catch (error) {
      if (traceSnapshotWrites) {
        const evidence = JSON.stringify({ fetches: childTrace(), relayReceives: snapshotWriteRecords.slice(writesBefore), uploadWork: observedWork() });
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}; safe snapshot transport evidence: ${evidence}`, { cause: error });
      }
      throw error;
    }
    if (traceSnapshotWrites) result.snapshotTrace = childTrace();
    if (cliChildren) {
      const observedUploads = snapshotWriteCount - writesBefore;
      const observedWrites = snapshotWriteRecords.slice(writesBefore);
      const safeTrace = result.snapshotTrace ?? [];
      try {
        if (traceSnapshotWrites) assertSnapshotCheckpoints(safeTrace, snapshotUploads);
        else assert.equal(observedUploads, snapshotUploads, 'untraced setup uploads match the plan');
      } catch (error) {
        error.message += `; private CLI child ${cliChildIndex}; client fetches: ${JSON.stringify(safeTrace)}; relay receives: ${JSON.stringify(observedWrites)}`;
        throw error;
      }
    }
    if (cliChildren && requestedUploads !== undefined) {
      assert.equal(requestedUploads, snapshotUploads, `private CLI child ${cliChildIndex} uses its declared upload count`);
    }
    return result;
  }
  /** Invoke the production CLI in this private repository under its planned budget, when present. */
  async function cli(...args) {
    return runCliChild(args, undefined, args[0] === 'status');
  }
  /** Invoke the production CLI from another worktree sharing this fixture's repository and home. */
  async function cliAt(cwd, ...args) {
    return childResult(cwd, env, [CLI, ...args, '--json']);
  }
  /** Bound a CLI child using the exact snapshot count asserted by its fixture flow. */
  async function cliWithSnapshotUploads(snapshotUploads, ...args) {
    cliChildDeadlineMs(snapshotUploads);
    return runCliChild(args, snapshotUploads, args[0] === 'status');
  }
  /** Run a CLI child with sanitized local snapshot callsite tracing for diagnosis. */
  async function cliWithSnapshotTrace(snapshotUploads, ...args) {
    cliChildDeadlineMs(snapshotUploads);
    return runCliChild(args, snapshotUploads, true);
  }
  /** Start live CLI output; raw mode also preserves the foreground wait for an already-paired phone's link tap. */
  function startCli(args, extraEnv = {}, { json = true } = {}) {
    const child = spawn(process.execPath, [CLI, ...args, ...(json ? ['--json'] : [])], { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const deadlineMs = cliChildDeadlineMs(DEFAULT_SNAPSHOT_UPLOADS);
    /** Stop a private CLI process that exceeds the fixture's upload-derived ceiling. */
    function stopOverdueChild() { child.kill('SIGKILL'); }
    const watchdog = setTimeout(stopOverdueChild, deadlineMs);
    watchdog.unref?.();
    /** Retain streamed standard output for the final machine-readable result. */
    function captureStdout(part) { stdout += part; }
    /** Retain streamed standard error so the browser can follow the printed confirmation URL. */
    function captureStderr(part) { stderr += part; }
    child.stdout.setEncoding('utf8').on('data', captureStdout);
    child.stderr.setEncoding('utf8').on('data', captureStderr);
    /** Preserve a single terminal result for both output waiters and fixture cleanup. */
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    /** Capture child exit without losing stdout or stderr already delivered to this fixture. */
    function onClose(code, signal) {
      clearTimeout(watchdog);
      resolveClosed({ code, signal, stdout, stderr });
    }
    child.once('close', onClose);
    /** Reject prompt waits when the child closes before the expected text appears. */
    function failClosed() { throw new Error('private CLI closed before its expected prompt'); }
    /** Wait for a specific streamed prompt, or fail when the child exits before printing it. */
    async function waitForOutput(marker) {
      while (!stderr.includes(marker)) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('private CLI exited before its expected prompt');
        await Promise.race([once(child.stderr, 'data'), closed.then(failClosed)]);
      }
      return stderr;
    }
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await closed;
    });
    return { child, closed, deadlineMs, waitForOutput, get stdout() { return stdout; }, get stderr() { return stderr; } };
  }
  assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8' }).status, 0);
  writeFileSync(join(root, 'README.md'), 'private relay fixture project\n', { mode: 0o600 });
  assert.equal(runFixtureChild('git', ['add', 'README.md'], { cwd: root, env, encoding: 'utf8' }).status, 0);
  assert.equal(runFixtureChild('git', ['commit', '-q', '-m', 'fixture base'], { cwd: root, env, encoding: 'utf8' }).status, 0, 'fixture clone starts from a committed project');
  assert.equal((await cli('init')).code, 0);
  assert.equal(runFixtureChild('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: root, env, encoding: 'utf8' }).status, 0);
  const lane = Object.keys(JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).lanes)[0];
  assert.equal((await cli('add', lane, 'private cleanup fixture item')).code, 0);
  const before = (await cli('export')).document;
  const id = before.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value;
  const linkFile = join(root, '.git', 'pullboard', 'relay.json');
  const keyFile = join(env.PULLBOARD_HOME, 'relay-keys', id + '.key');

  /** Start a saved real relay link without exposing the pairing fragment. */
  async function link(name) {
    const result = await cli('relay', 'on', '--url', origin, ...(name === undefined ? [] : ['--name', name]));
    assert.equal(result.code, 0, 'real device sign-in links the board');
    privateKeys.add(readFileSync(keyFile, 'utf8').trim());
    return result;
  }
  /** Raise this fixture board's durable minimum to the current engine before compatibility checks. */
  async function requireEngineThree() {
    const state = JSON.parse(readFileSync(linkFile, 'utf8'));
    await auth.issueToken(state.token, { board: state.board, agent: 'fixture-engine-minimum' });
    return auth.minimumEngineVersion(state.board);
  }
  /** Pair and unlink from a second real repository with its own private device home and key. */
  async function otherDeviceOff() {
    const otherRoot = join(scratch, 'other-device');
    const otherHome = join(scratch, 'other-home');
    mkdirSync(otherRoot);
    mkdirSync(otherHome, { mode: 0o700 });
    const otherEnv = { ...env, HOME: otherHome, PULLBOARD_HOME: join(otherHome, '.pullboard') };
    /** Invoke the independent device's production CLI without retaining its output in diagnostics. */
    const run = (...args) => childResult(otherRoot, otherEnv, [CLI, ...args, '--json']);
    assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: otherRoot, env: otherEnv, encoding: 'utf8' }).status, 0);
    assert.equal((await run('init')).code, 0);
    assert.equal(runFixtureChild('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: otherRoot, env: otherEnv, encoding: 'utf8' }).status, 0);
    const snapshot = join(scratch, 'snapshot.json');
    writeFileSync(snapshot, JSON.stringify(before), { mode: 0o600 });
    assert.equal((await run('import', snapshot)).code, 0, 'second device imports the same real board');
    assert.equal((await run('relay', 'on', '--url', origin)).code, 0, 'second device signs in independently');
    return (await run('relay', 'off')).code;
  }
  /** Clone the same committed project into a separate repository/home, then join through a printed code. */
  async function otherDeviceJoin(code, name) {
    const bare = join(scratch, 'project.git');
    const otherRoot = join(scratch, 'paired-clone');
    const otherHome = join(scratch, 'paired-home');
    mkdirSync(otherHome, { mode: 0o700 });
    const otherEnv = { ...env, HOME: otherHome, PULLBOARD_HOME: join(otherHome, '.pullboard'), PULLBOARD_MACHINE_HOME: join(scratch, 'paired-machine') };
    assert.equal(runFixtureChild('git', ['clone', '--bare', root, bare], { cwd: scratch, env: otherEnv, encoding: 'utf8' }).status, 0, 'fixture project creates a private bare remote');
    assert.equal(runFixtureChild('git', ['clone', bare, otherRoot], { cwd: scratch, env: otherEnv, encoding: 'utf8' }).status, 0, 'second device is a real clone');
    assert.equal(runFixtureChild('git', ['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: otherRoot, env: otherEnv, encoding: 'utf8' }).status, 0, 'clone names the same authorized repository');
    const run = (...args) => childResult(otherRoot, otherEnv, [CLI, ...args, '--json']);
    const initEnv = { ...otherEnv };
    delete initEnv.PULLBOARD_MODEL; // Pairing imports the source coordinator's declaration.
    assert.equal((await childResult(otherRoot, initEnv, [CLI, 'init', '--json'])).code, 0, 'the cloned project initializes its private local board');
    const joined = await run('relay', 'join', code, '--url', origin, ...(name === undefined ? [] : ['--name', name]));
    const document = joined.document;
    if (joined.code !== 0) throw new Error('real clone did not join the one-use pairing code');
    const exported = await run('export');
    if (exported.code !== 0) throw new Error('paired clone could not read its restored board');
    const link = JSON.parse(readFileSync(join(otherRoot, '.git', 'pullboard', 'relay.json'), 'utf8'));
    const otherKeyFile = join(otherEnv.PULLBOARD_HOME, 'relay-keys', link.board + '.key');
    const environmentKey = readFileSync(otherKeyFile, 'utf8').trim();
    /** Run a real linked-clone command with only the environment key, after removing its key file. */
    async function syncWithEnvironmentKey(...args) {
      rmSync(otherKeyFile, { force: true });
      assert.equal(existsSync(otherKeyFile), false, 'the paired clone has no stored board-key file');
      const envKey = { ...otherEnv, PULLBOARD_RELAY_KEY: environmentKey };
      return childResult(otherRoot, envKey, [CLI, ...args, '--json']);
    }
    return { joined: document, machine: link.machine, exported: exported.document, cli: run, root: otherRoot, env: otherEnv, syncWithEnvironmentKey,
      /** Run a second-device worktree with that device's own keys and bounded asynchronous child. */
      cliAt(cwd, ...args) { return childResult(cwd, otherEnv, [CLI, ...args, '--json']); },
      /** Check that the paired clone still has no persisted board-key file. */
      keyFileExists() { return existsSync(otherKeyFile); } };
  }
  /** Link another independently initialized synthetic board through the same real person account. */
  async function additionalBoard(title, { sharedHome = false } = {}) {
    const nextRoot = mkdtempSync(join(scratch, 'additional-board-'));
    const nextHome = sharedHome ? home : mkdtempSync(join(scratch, 'additional-home-'));
    const nextEnv = { ...env, HOME: nextHome, PULLBOARD_HOME: join(nextHome, '.pullboard') };
    /** Run this separate board without retaining credentials in diagnostic output. */
    const run = (...args) => childResult(nextRoot, nextEnv, [CLI, ...args, '--json']);
    assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: nextRoot, env: nextEnv, encoding: 'utf8' }).status, 0);
    assert.equal((await run('init')).code, 0);
    // Its own repository: the relay links one team board per repository [E12].
    const repository = 'repository-' + (provider.state.repositories.length + 1);
    provider.state.repositories.push(repository);
    assert.equal(runFixtureChild('git', ['remote', 'add', 'origin', `git@github.com:fixture/${repository}.git`], { cwd: nextRoot, env: nextEnv, encoding: 'utf8' }).status, 0);
    assert.equal((await run('add', lane, title)).code, 0);
    assert.equal((await run('relay', 'on', '--url', origin)).code, 0);
    const state = JSON.parse(readFileSync(join(nextRoot, '.git', 'pullboard', 'relay.json'), 'utf8'));
    const encoded = readFileSync(join(nextEnv.PULLBOARD_HOME, 'relay-keys', state.board + '.key'), 'utf8').trim();
    privateKeys.add(encoded);
    /** Run native fixture actions in this board's own home; no caller changes the parent process environment. */
    async function script(source) { return childResult(nextRoot, nextEnv, ['--input-type=module', '-e', source]); }
    return { id: state.board, encoded, cli: run, script };
  }
  /** Run multiple production commands in one process, emitting only safe counters. */
  async function script(source) {
    return childResult(root, env, ['--input-type=module', '-e', source]);
  }
  return {
    transit, providerState: provider.state, providerCalls: provider.calls, providerOrigin: provider.origin, relayDirectory: join(scratch, 'relay'), authDatabase, auth, otherDeviceJoin,
    root, env, origin, lane, before, linkFile, keyFile, calls, moveAcks, cli, cliAt, cliWithSnapshotUploads, cliWithSnapshotTrace, startCli, waitForResponse, holdNextConfirmationStatus, link, phoneSession, requireEngineThree, otherDeviceOff, additionalBoard, script, stopRelay, restartRelay,
    /** Assert the test consumed every declared child budget, with no hidden CLI calls. */
    assertCliChildrenComplete() {
      if (cliChildren) assert.equal(cliChildIndex, cliChildren.length, 'every planned private CLI child ran exactly once');
    },
    /** Interleave one real authenticated relay write immediately before the next native move. */
    beforeNextMove(action) { beforeMove = action; },
    /** Move the relay clock by an explicit offset while preserving elapsed native wall time. */
    advance(days) { timeOffsetMs = days * 86400000; },
    overrideDelete(value) { override = value; },
    failTokenMints(count) { mintFailures = count; },
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
    loseNextSnapshotReply(options = {}) { loseSnapshotReply = { thenStateReads: options.thenStateReads ?? null }; },
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
    mainURL: new URL('../src/cli.js', import.meta.url).href,
    keyInRequest() { return keyLeaked; },
    /** Revoke the actual synthetic person session, including its current live streams. */
    async revokeSession() { const session = await phoneSession(); return auth.revoke(session.token, session.id); },
    /** Revoke the real session when the next listing arrives so its HTTP authorization refusal is exercised. */
    revokeSessionOnNextListing() { revokeOnNextListing = true; },
    refuseReads(value) { refuseEventReads = value; },
    /** Return a selected listed-board read's missing-snapshot refusal over real HTTP. */
    noBoardOnReads(id, paths = ['state']) {
      boardsWithoutSnapshots.set(id, new Set(paths));
    },
  };
}


/** Preserve explicit API1 wire-contract cases while the default fixture exercises current API2 writers. */
export async function legacyRelayClientFixture(t, options) {
  const box = await relayClientFixture(t, options);
  box.legacySnapshotApi();
  return box;
}
