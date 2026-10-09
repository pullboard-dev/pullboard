/** Private real CLI, auth and relay fixture; credentials never enter assertion messages [H1,H7,H18]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Transform } from 'node:stream';
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

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');
const MAX_OBSERVED_SNAPSHOT_UPLOADS = MAX_SNAPSHOT_ATTEMPTS;
const DEFAULT_SNAPSHOT_UPLOADS = 3;

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
        assert.ok(write.callers.some(caller => caller.includes('async retry@cli.js:')), 'syncRelay retries the persisted checkpoint');
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
    const startedAt = Date.now();
    const command = argv[0] === CLI ? (argv[1] ?? 'CLI') : (argv[0] ?? 'script');
    let deadlineAt = startedAt + cliChildDeadlineMs(initialSnapshotUploads);
    const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let exceededDeadline = false;
    const timer = setInterval(() => {
      const count = observedSnapshotUploads?.() ?? initialSnapshotUploads;
      if (count > MAX_OBSERVED_SNAPSHOT_UPLOADS) {
        exceededDeadline = true;
        child.kill('SIGKILL');
        return;
      }
      deadlineAt = Math.max(deadlineAt, startedAt + cliChildDeadlineMs(count));
      if (Date.now() >= deadlineAt) { exceededDeadline = true; child.kill('SIGKILL'); }
    }, 20);
    child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
    child.stderr.resume();
    child.once('error', error => { clearInterval(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearInterval(timer);
      if (signal) return reject(new Error(exceededDeadline
        ? `Private relay fixture ${command} exceeded its ${deadlineAt - startedAt}ms upload-derived deadline after ${Date.now() - startedAt}ms.`
        : `Private relay fixture ${command} ended with signal ${signal} after ${Date.now() - startedAt}ms.`));
      let document;
      try { document = JSON.parse(stdout); }
      catch { return reject(new Error('private relay fixture child did not return JSON')); }
      resolveResult({ code, document, snapshotUploads: observedSnapshotUploads?.() ?? initialSnapshotUploads,
        snapshotDeadlineMs: deadlineAt - startedAt });
    });
  });
}

/** Start an isolated board with fallback-file keys and a real authorized loopback relay. */
export async function relayClientFixture(t, { cliChildren } = {}) {
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
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Relay Fixture', GIT_AUTHOR_EMAIL: 'relay-fixture@example.com',
    GIT_COMMITTER_NAME: 'Relay Fixture', GIT_COMMITTER_EMAIL: 'relay-fixture@example.com',
  };
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
  for (const name of ['PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN']) delete env[name];
  const provider = await githubFixture(t);
  provider.state.deviceAuthorized = true;
  const authDatabase = join(scratch, 'auth.sqlite');
  let auth;
  let time = Date.now();
  let override = null;
  let mintFailures = 0;
  let refuseEventReads = false;
  let revokeOnNextListing = false;
  const boardsWithoutSnapshots = new Map();
  const injectedSnapshotWriteDelayMs = Number(process.env.PULLBOARD_TEST_SNAPSHOT_WRITE_DELAY_MS ?? 0);
  assert.ok(Number.isSafeInteger(injectedSnapshotWriteDelayMs) && injectedSnapshotWriteDelayMs >= 0 && injectedSnapshotWriteDelayMs <= 15000,
    'injected snapshot delay is within the product wait bound');
  let snapshotWriteDelayMs = 0;
  let oneSnapshotDelay = null;
  let snapshotWriteCount = 0;
  const snapshotWriteDelays = [];
  const snapshotWriteRecords = [];
  let stateReadDelayMs = 0;
  let stateReadHold = null;
  let stateReadStarted = 0;
  let refuseSnapshotWrites = false;
  let refuseRequestWrites = false;
  let signIn;
  let api;
  const calls = [];
  const transit = [];
  const moveAcks = [];
  const privateKeys = new Set();
  let keyLeaked = false;
  const server = createServer(async (req, res) => {
    const snapshotWrite = req.method === 'PUT' && /\/api\/v1\/boards\/[0-9a-f]{32}\/state$/.test(req.url ?? '');
    if (snapshotWrite) snapshotWriteCount += 1;
    const requestChunks = [];
    const responseChunks = [];
    const snapshotStartedAt = Date.now();
    const snapshotRecord = snapshotWrite ? { at: snapshotStartedAt, sequence: null, ciphertext: null, status: null, elapsedMs: null, responseClosedBeforeFinish: false } : null;
    if (snapshotRecord) snapshotWriteRecords.push(snapshotRecord);
    const request = new Transform({
      transform(chunk, _encoding, callback) {
        requestChunks.push(Buffer.from(chunk));
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
    const end = res.end.bind(res);
    res.end = (chunk, ...args) => {
      captureResponse(chunk);
      if (req.method === 'POST' && /\/api\/v1\/boards\/[0-9a-f]{32}\/moves$/.test(req.url ?? '') && (typeof chunk === 'string' || Buffer.isBuffer(chunk))) {
        try {
          const response = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
          if (typeof response.event?.sealed === 'string') moveAcks.push(response.event);
        } catch { /* Capture only valid move acknowledgements; the production response remains unchanged. */ }
      }
      return end(chunk, ...args);
    };
    res.once('finish', () => transit.push({ method: req.method, path: req.url,
      request: Buffer.concat(requestChunks), response: Buffer.concat(responseChunks) }));
    calls.push({ method: req.method, path: req.url, accept: req.headers.accept ?? '', engine: req.headers['x-pullboard-engine'] });
    if (revokeOnNextListing && req.method === 'GET' && req.url === '/api/v1/boards') {
      revokeOnNextListing = false;
      const state = JSON.parse(readFileSync(linkFile, 'utf8'));
      await auth.revoke(state.token, state.tokenId);
    }
    if ([...privateKeys].some(key => JSON.stringify({ url: req.url, headers: req.headers }).includes(key))) keyLeaked = true;
    const missingSnapshot = /^\/api\/v1\/boards\/([0-9a-f]{32})\/(state|events)(?:\?|$)/u.exec(req.url ?? '');
    if (req.method === 'GET' && missingSnapshot && boardsWithoutSnapshots.get(missingSnapshot[1])?.has(missingSnapshot[2])) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: 'NO_BOARD', message: 'upload the sealed snapshot for this linked board first' } }));
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
    if (refuseSnapshotWrites && req.method === 'PUT' && /\/api\/v1\/boards\/[0-9a-f]{32}\/state$/.test(req.url ?? '')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: 'RELAY_UNAVAILABLE', message: 'fixture snapshot outage' } }));
      return;
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
    if (await signIn(request, res)) return;
    await api(request, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const relayPort = server.address().port;
  const origin = 'http://127.0.0.1:' + relayPort;
  auth = createRelayAuth({ database: authDatabase, github: createGitHubClient({ ...provider.config, callbackURL: origin + '/auth/github/callback' }) });
  signIn = createAuthHandler({ auth, publicOrigin: origin });
  api = createRelayHandler({ directory: join(scratch, 'relay'), auth, publicOrigin: origin, pollMs: 10, maintenanceMs: 0, now: () => time });
  t.after(async () => {
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
    const childEnv = traceSnapshotWrites ? { ...env, PULLBOARD_TEST_RELAY_TRACE_FILE: traceFile,
      PULLBOARD_TEST_RELAY_TRACE_ORIGIN: origin,
      NODE_OPTIONS: [env.NODE_OPTIONS, '--import=' + pathToFileURL(tracePreload).href].filter(Boolean).join(' ') } : env;
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
      result = await childResult(root, childEnv, [CLI, ...args, '--json'],
        traceSnapshotWrites ? () => snapshotWriteCount - writesBefore : undefined, initialUploads);
    } catch (error) {
      if (traceSnapshotWrites) {
        const evidence = JSON.stringify({ fetches: childTrace(), relayReceives: snapshotWriteRecords.slice(writesBefore) });
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
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env }).status, 0);
  writeFileSync(join(root, 'README.md'), 'private relay fixture project\n', { mode: 0o600 });
  assert.equal(spawnSync('git', ['add', 'README.md'], { cwd: root, env }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'fixture base'], { cwd: root, env }).status, 0, 'fixture clone starts from a committed project');
  assert.equal((await cli('init')).code, 0);
  assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: root, env }).status, 0);
  const lane = Object.keys(JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).lanes)[0];
  assert.equal((await cli('add', lane, 'private cleanup fixture item')).code, 0);
  const before = (await cli('export')).document;
  const id = before.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value;
  const linkFile = join(root, '.git', 'pullboard', 'relay.json');
  const keyFile = join(env.PULLBOARD_HOME, 'relay-keys', id + '.key');

  /** Start a saved real relay link without exposing the pairing fragment. */
  async function link() {
    assert.equal((await cli('relay', 'on', '--url', origin)).code, 0, 'real device sign-in links the board');
    privateKeys.add(readFileSync(keyFile, 'utf8').trim());
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
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: otherRoot, env: otherEnv }).status, 0);
    assert.equal((await run('init')).code, 0);
    assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: otherRoot, env: otherEnv }).status, 0);
    const snapshot = join(scratch, 'snapshot.json');
    writeFileSync(snapshot, JSON.stringify(before), { mode: 0o600 });
    assert.equal((await run('import', snapshot)).code, 0, 'second device imports the same real board');
    assert.equal((await run('relay', 'on', '--url', origin)).code, 0, 'second device signs in independently');
    return (await run('relay', 'off')).code;
  }
  /** Clone the same committed project into a separate repository/home, then join through a printed code. */
  async function otherDeviceJoin(code) {
    const bare = join(scratch, 'project.git');
    const otherRoot = join(scratch, 'paired-clone');
    const otherHome = join(scratch, 'paired-home');
    mkdirSync(otherHome, { mode: 0o700 });
    const otherEnv = { ...env, HOME: otherHome, PULLBOARD_HOME: join(otherHome, '.pullboard'), PULLBOARD_MACHINE_HOME: join(scratch, 'paired-machine') };
    assert.equal(spawnSync('git', ['clone', '--bare', root, bare], { cwd: scratch, env: otherEnv }).status, 0, 'fixture project creates a private bare remote');
    assert.equal(spawnSync('git', ['clone', bare, otherRoot], { cwd: scratch, env: otherEnv }).status, 0, 'second device is a real clone');
    assert.equal(spawnSync('git', ['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: otherRoot, env: otherEnv }).status, 0, 'clone names the same authorized repository');
    const run = (...args) => childResult(otherRoot, otherEnv, [CLI, ...args, '--json']);
    assert.equal((await run('init')).code, 0, 'the cloned project initializes its private local board');
    const joined = await run('relay', 'join', code, '--url', origin);
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
    return { joined: document, exported: exported.document, cli: run, syncWithEnvironmentKey,
      /** Check that the paired clone still has no persisted board-key file. */
      keyFileExists() { return existsSync(otherKeyFile); } };
  }
  /** Link another independently initialized synthetic board through the same real person account. */
  async function additionalBoard(title) {
    const nextRoot = mkdtempSync(join(scratch, 'additional-board-'));
    const nextHome = mkdtempSync(join(scratch, 'additional-home-'));
    const nextEnv = { ...env, HOME: nextHome, PULLBOARD_HOME: join(nextHome, '.pullboard') };
    /** Run this separate board without retaining credentials in diagnostic output. */
    const run = (...args) => childResult(nextRoot, nextEnv, [CLI, ...args, '--json']);
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: nextRoot, env: nextEnv }).status, 0);
    assert.equal((await run('init')).code, 0);
    assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: nextRoot, env: nextEnv }).status, 0);
    assert.equal((await run('add', lane, title)).code, 0);
    assert.equal((await run('relay', 'on', '--url', origin)).code, 0);
    const state = JSON.parse(readFileSync(join(nextRoot, '.git', 'pullboard', 'relay.json'), 'utf8'));
    const encoded = readFileSync(join(nextEnv.PULLBOARD_HOME, 'relay-keys', state.board + '.key'), 'utf8').trim();
    privateKeys.add(encoded);
    return { id: state.board, encoded, cli: run };
  }
  /** Run multiple production commands in one process, emitting only safe counters. */
  async function script(source) {
    return childResult(root, env, ['--input-type=module', '-e', source]);
  }
  return {
    transit, relayDirectory: join(scratch, 'relay'), authDatabase, otherDeviceJoin,
    root, env, origin, lane, before, linkFile, keyFile, calls, moveAcks, cli, cliWithSnapshotUploads, cliWithSnapshotTrace, link, requireEngineThree, otherDeviceOff, additionalBoard, script, stopRelay, restartRelay,
    /** Assert the test consumed every declared child budget, with no hidden CLI calls. */
    assertCliChildrenComplete() {
      if (cliChildren) assert.equal(cliChildIndex, cliChildren.length, 'every planned private CLI child ran exactly once');
    },
    advance(days) { time = Date.now() + days * 86400000; },
    overrideDelete(value) { override = value; },
    failTokenMints(count) { mintFailures = count; },
    refuseSnapshotWrites(value) { refuseSnapshotWrites = value; },
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
    mainURL: new URL('../src/cli.js', import.meta.url).href,
    keyInRequest() { return keyLeaked; },
    /** Revoke the actual synthetic person session, including its current live streams. */
    revokeSession() { const state = JSON.parse(readFileSync(linkFile, 'utf8')); return auth.revoke(state.token, state.tokenId); },
    /** Revoke the real session when the next listing arrives so its HTTP authorization refusal is exercised. */
    revokeSessionOnNextListing() { revokeOnNextListing = true; },
    refuseReads(value) { refuseEventReads = value; },
    /** Return a selected listed-board read's missing-snapshot refusal over real HTTP. */
    noBoardOnReads(id, paths = ['state']) {
      boardsWithoutSnapshots.set(id, new Set(paths));
    },
  };
}
