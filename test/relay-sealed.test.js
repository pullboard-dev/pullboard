/** Two real clients and encrypted CLI records exercise the relay without sharing their key [A4,H7]. */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { serveRelay } from '../relay/service.js';
import { createRelayAuth } from '../relay/auth.js';
import { createGitHubClient } from '../relay/github.js';
import { githubFixture } from './relay-fixture.js';
import * as store from '../src/board.js';
import { exportBoard } from '../src/exchange.js';
import { checkpointSequence, engineReceipt, prepareEngineMove } from '../src/engine.js';
import { seal as sealMove } from '../src/seal.js';
import { ENGINE_VERSION } from '../src/machine.js';

/** Seal on the test client only; nonce, authentication tag and ciphertext are opaque to the server. */
function seal(key, value, binding) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(binding)));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, bytes, cipher.getAuthTag()]).toString('base64url');
}

/** Open on the test client only, proving that received ciphertext still represents the sent record. */
function unseal(key, value, binding) {
  const bytes = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
  assert.equal(bytes[0], 1);
  decipher.setAuthTag(bytes.subarray(-16));
  decipher.setAAD(Buffer.from(JSON.stringify(binding)));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(13, -16)), decipher.final()]).toString());
}

/** Create a real private CLI board, actual stand-in GitHub sign-in, and an ephemeral relay server. */
async function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-sealed-http-')));
  const root = join(directory, 'repo');
  const home = join(directory, 'home');
  const data = join(directory, 'relay');
  const privateBin = join(directory, 'bin');
  mkdirSync(root); mkdirSync(home); mkdirSync(privateBin);
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.PULLBOARD_RELAY_TOKEN;
  const quoteShell = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const cliPath = resolve(import.meta.dirname, '../bin/pullboard.js');
  const pullboardPath = join(privateBin, 'pullboard');
  writeFileSync(pullboardPath, `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(cliPath)} "$@"\n`);
  chmodSync(pullboardPath, 0o755);
  env.PATH = [privateBin, env.PATH].filter(Boolean).join(delimiter);
  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  /** Run the current CLI only in the fixture's private home and Git repository. */
  function cli(...args) {
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  cli('init');
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  const marker = 'PRIVATE_BOARD_CRITERION_DO_NOT_RELAY_IN_CLEAR';
  cli('add', Object.keys(config.lanes)[0], 'A sealed board item', '--criterion', marker);
  const document = JSON.parse(cli('export'));
  const id = document.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value;
  const provider = await githubFixture(t);
  const auth = createRelayAuth({ database: join(directory, 'auth.sqlite'), github: createGitHubClient(provider.config) });
  const flow = auth.beginWeb();
  const redirect = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const callback = new URL(redirect.headers.get('location'));
  const person = await auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), flow.binding);
  await auth.linkBoard(person.token, id, 'fixture/repository');
  const one = await auth.issueToken(person.token, { board: id, agent: 'client-one' });
  const two = await auth.issueToken(person.token, { board: id, agent: 'client-two' });
  const relay = await serveRelay({ directory: data, auth, port: 0, pollMs: 20, publicOrigin: 'http://127.0.0.1:44444' });
  t.after(async () => { await relay.close(); auth.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + relay.port;
  const key = randomBytes(32);

  /** Send one private API call without putting credentials or board keys in its URL or diagnostics. */
  async function call(path, { method = 'GET', body, token = one.token, headers = {} } = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: { 'x-pullboard-engine': '3', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  /** Bind each client seal to its board, kind and proposed transport position. */
  function clientSeal(value, kind, sequence, board = id) { return seal(key, value, { board, kind, sequence }); }
  /** Unseal received records at their actual committed position, never the client's old proposal. */
  function clientOpen(value, kind, sequence, board = id) { return unseal(key, value, { board, kind, sequence }); }
  return { directory, root, home, env, data, cli, document, id, marker, auth, person, one, two, relay, origin, key, call, clientSeal, clientOpen, path: '/api/v1/boards/' + id };
}

/** Run a linked CLI asynchronously so the real relay can serve it, keeping credentials out of diagnostics. */
function replayClient(root, env, ...args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), ...args, '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
    child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return fail(new Error('isolated linked CLI command failed'));
      try { done(JSON.parse(stdout)); } catch { fail(new Error('isolated linked CLI did not return JSON')); }
    });
  });
}

/** Replay through the native CLI while acknowledging but suppressing checkpoint writes to the fixture relay. */
function replayClientWithoutCheckpoint(root, env) {
  const cliURL = pathToFileURL(resolve(import.meta.dirname, '../src/cli.js')).href;
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
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
    child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return fail(new Error('isolated native client failed during checkpoint-suppressed replay'));
      try { done(JSON.parse(stdout)); } catch { fail(new Error('checkpoint-suppressed native client returned invalid JSON')); }
    });
  });
}

/** Keep each client on its own replay path by blocking checkpoint publication, forwarding all reads to the real relay. */
async function independentReplayOrigin(t, origin) {
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
function replayResult(root, env, ...args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), ...args, '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === null) return fail(new Error('isolated relay command did not finish'));
      try { done({ document: JSON.parse(stdout), stderr, status: code }); }
      catch { fail(new Error('isolated relay read did not return JSON')); }
    });
  });
}

test('sealed agent shout cannot answer a person decision on either independent client [H16,B26]', async t => {
  const box = await fixture(t);
  const source = store.openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let document, question, forged, ordinary, answer;
  try {
    const lane = store.getItem(source, 1).item_lane;
    assert.equal(store.register(source, { lane: 'remote', path: join(box.directory, 'remote') }), 'remote-1');
    question = store.shout(source, {
      from: 'coordinator', to: 'person', text: 'Approve this change?', decision: true, lanes: [lane],
    });
    checkpointSequence(source, 0);
    // This is intentionally a raw authenticated-agent shout, not answerDecision.
    // The relay must reject its answer relation before insertShout can close the question.
    forged = prepareEngineMove(source, 'shout', [{
      from: 'remote-1', to: 'coordinator', text: 'Forged approval', answers: question, lanes: [lane],
    }]);
    ordinary = prepareEngineMove(source, 'shout', [{
      from: 'remote-1', to: 'all', text: 'Ordinary agent observation', lanes: [lane],
    }]);
    answer = prepareEngineMove(source, 'answerDecision', [question, {
      agentId: 'coordinator', asPerson: true, text: 'Approved by the person', lanes: [lane],
    }]);
    document = JSON.parse(JSON.stringify(exportBoard(source)));
  } finally { store.closeBoard(source); }

  const remote = await box.auth.issueToken(box.person.token, { board: box.id, agent: 'remote-1' });
  const roots = [box.root, join(box.directory, 'second-client')];
  const homes = [box.home, join(box.directory, 'second-home')];
  const envs = homes.map(home => ({ ...box.env, HOME: home, PULLBOARD_HOME: home }));
  mkdirSync(roots[1]); mkdirSync(homes[1], { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: roots[1], env: envs[1] }).status, 0);
  await replayClient(roots[1], envs[1], 'init');
  const native = join(box.directory, 'native.json');
  writeFileSync(native, JSON.stringify(document), { mode: 0o600 });
  await replayClient(roots[1], envs[1], 'import', native);
  for (let i = 0; i < roots.length; i++) {
    const keyDirectory = join(homes[i], 'relay-keys');
    mkdirSync(keyDirectory, { mode: 0o700 });
    writeFileSync(join(keyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
    const url = await independentReplayOrigin(t, box.origin);
    writeFileSync(join(roots[i], '.git/pullboard/relay.json'), JSON.stringify({
      version: 1, mode: 'ordered', board: box.id, url, repository: 'fixture/repository',
      token: box.person.token, sequence: 0, cursor: document.tables.event.at(-1).event_id,
    }) + '\n', { mode: 0o600 });
  }

  /** Send a production-sealed move using its actual authenticated relay credential. */
  async function upload(move, sequence, token = remote.token) {
    const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(move)), {
      boardId: box.id, kind: 'move', sequence,
    })).toString('base64url');
    const reply = await box.call(box.path + '/moves', {
      method: 'POST', token, body: { sequence, sealed },
    });
    assert.equal(reply.status, 200);
    return reply;
  }
  const snapshot = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(document)), {
    boardId: box.id, kind: 'snapshot', sequence: 0,
  })).toString('base64url');
  assert.equal((await box.call(box.path + '/state', {
    method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: snapshot },
  })).status, 200);
  const forgedUpload = await upload(forged, 1);
  assert.equal(forgedUpload.body.event.sender.agent, 'remote-1');
  await upload(ordinary, 2);

  const refusedReplicas = [];
  for (let i = 0; i < roots.length; i++) {
    const result = await replayResult(roots[i], envs[i], 'export');
    assert.equal(result.status, 0);
    const doc = result.document;
    const q = doc.tables.shout.find(row => row.shout_id === question);
    assert.ok(q && q.shout_decision, 'the person decision remains present');
    assert.equal(doc.tables.shout.some(row => row.shout_answers === question), false, 'the refused agent record did not answer it');
    assert.equal(doc.tables.shout.at(-1).shout_text, 'Ordinary agent observation', 'ordinary agent shouts remain allowed');
    const refusal = doc.tables.event.find(row => row.event_kind === 'relay_refused' && row.event_by === 'remote-1');
    assert.equal(JSON.parse(refusal.event_detail).code, 'RELAY_ANSWER');
    assert.equal(doc.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '2');
    const board = store.openBoard(join(roots[i], '.git/pullboard/board.sqlite'));
    try { assert.deepEqual(store.openDecisions(board, 'person').map(row => row.shout_id), [question]); }
    finally { store.closeBoard(board); }
    refusedReplicas.push(doc.tables);
  }
  assert.deepEqual(refusedReplicas[0], refusedReplicas[1], 'both clients independently replay the refusal and allowed shout');
  const beforeAnswer = refusedReplicas[0];

  // A valid, sealed person decision preserves the existing guarded answer path.
  await upload(answer, 3, box.person.token);
  const answered = [];
  for (let i = 0; i < roots.length; i++) {
    const result = await replayResult(roots[i], envs[i], 'export');
    assert.equal(result.status, 0);
    const doc = result.document;
    assert.equal(doc.tables.shout.some(row => row.shout_answers === question && row.shout_text === 'Approved by the person'), true);
    assert.equal(doc.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '3');
    assert.deepEqual(doc.tables.event.slice(0, beforeAnswer.event.length), beforeAnswer.event, 'the guarded answer preserves every earlier event row');
    assert.deepEqual(doc.tables.shout.slice(0, beforeAnswer.shout.length), beforeAnswer.shout, 'the guarded answer preserves earlier shout IDs and raw rows');
    const board = store.openBoard(join(roots[i], '.git/pullboard/board.sqlite'));
    try { assert.deepEqual(store.openDecisions(board, 'person'), []); }
    finally { store.closeBoard(board); }
    answered.push(doc.tables);
  }
  assert.deepEqual(answered[0], answered[1], 'both clients apply the actual guarded person answer identically');
  const retained = await box.call(box.path + '/state');
  assert.equal(retained.body.state.sequence, 0);
  assert.equal(retained.body.state.sealed, snapshot, 'both clients independently replayed rather than importing a published checkpoint');
});

test('two real clients stop before sender checks for newer operations and actor layouts without advancing [H16]', async t => {
  const futureEngine = ENGINE_VERSION + 1;
  const versionMessage = new RegExp(`engine version ${futureEngine}.*engine version ${ENGINE_VERSION}`);
  const unknown = { version: 1, engine: futureEngine, id: 'future-operation', operation: 'futureOp', args: [{ agentId: 'remote-1' }] };
  const shifted = { version: 1, engine: futureEngine, id: 'future-claim', operation: 'claim', args: [1, {}, { agentId: 'remote-1' }] };
  for (const [name, moves] of [['new operation', [unknown]], ['new actor layout', [shifted]], ['current engine sender checks', [unknown, shifted].map(move => ({ ...move, engine: ENGINE_VERSION }))]]) {
    await t.test(name, async sub => {
      const box = await fixture(sub);
      const source = store.openBoard(join(box.root, '.git/pullboard/board.sqlite'));
      let document;
      try {
        checkpointSequence(source, 0);
        document = JSON.parse(JSON.stringify(exportBoard(source)));
      } finally { store.closeBoard(source); }
      const remote = await box.auth.issueToken(box.person.token, { board: box.id, agent: 'remote-1' });
      const roots = [box.root, join(box.directory, 'second-client')];
      const homes = [box.home, join(box.directory, 'second-home')];
      const envs = homes.map(home => ({ ...box.env, HOME: home, PULLBOARD_HOME: home }));
      mkdirSync(roots[1]); mkdirSync(homes[1], { mode: 0o700 });
      assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: roots[1], env: envs[1] }).status, 0);
      await replayClient(roots[1], envs[1], 'init');
      const native = join(box.directory, 'native.json');
      writeFileSync(native, JSON.stringify(document), { mode: 0o600 });
      await replayClient(roots[1], envs[1], 'import', native);
      const links = roots.map(root => join(root, '.git/pullboard/relay.json'));
      for (let index = 0; index < roots.length; index += 1) {
        const keyDirectory = join(homes[index], 'relay-keys');
        mkdirSync(keyDirectory, { mode: 0o700 });
        writeFileSync(join(keyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
        const replayOrigin = await independentReplayOrigin(sub, box.origin);
        writeFileSync(links[index], JSON.stringify({ version: 1, mode: 'ordered', board: box.id, url: replayOrigin, repository: 'fixture/repository', token: box.person.token, sequence: 0, cursor: document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
      }
      const originalLinks = links.map(file => readFileSync(file, 'utf8'));
      const initialSnapshot = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(document)), { boardId: box.id, kind: 'snapshot', sequence: 0 })).toString('base64url');
      assert.equal((await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: initialSnapshot } })).status, 200);
      for (let index = 0; index < moves.length; index += 1) {
        const sequence = index + 1;
        const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(moves[index])), { boardId: box.id, kind: 'move', sequence })).toString('base64url');
        const uploaded = await box.call(box.path + '/moves', { method: 'POST', token: remote.token, body: { sequence, sealed } });
        assert.equal(uploaded.status, 200);
        assert.equal(uploaded.body.event.sender.agent, 'remote-1');
      }
      const results = [];
      for (let index = 0; index < roots.length; index += 1) {
        const result = await replayResult(roots[index], envs[index], 'export');
        assert.equal(result.status, 0);
        results.push(result.document);
        if (moves[0].engine === futureEngine) {
          assert.match((result.document.diagnostics ?? []).join('\n'), new RegExp(`\\[ENGINE_VERSION\\].*${versionMessage.source}.*upgrade pullboard`), 'future records stop before interpreting the sending agent');
          assert.deepEqual(result.document.tables, document.tables, 'no board row, receipt or persisted cursor changes');
          assert.equal(readFileSync(links[index], 'utf8'), originalLinks[index], 'the saved transport cursor is unchanged');
          const retried = await replayResult(roots[index], envs[index], 'export');
          assert.match((retried.document.diagnostics ?? []).join('\n'), /\[ENGINE_VERSION\]/);
          assert.equal(retried.status, 0);
          assert.deepEqual(retried.document.tables, document.tables, 'retry still stops at the same unapplied record');
          const attempted = await replayResult(roots[index], envs[index], 'add', document.tables.item[0].item_lane, 'Later local move must wait');
          assert.equal(attempted.status, 1);
          assert.equal(attempted.document.error.code, 'ENGINE_VERSION');
          assert.match(attempted.document.error.message, versionMessage);
          assert.equal(readFileSync(links[index], 'utf8'), originalLinks[index]);
          const board = store.openBoard(join(roots[index], '.git/pullboard/board.sqlite'));
          try { assert.deepEqual(JSON.parse(JSON.stringify(exportBoard(board))).tables, document.tables, 'a later local mutation cannot pass the future record'); }
          finally { store.closeBoard(board); }
        } else {
          assert.doesNotMatch((result.document.diagnostics ?? []).join('\n'), /\[ENGINE_VERSION\]/);
          assert.deepEqual(result.document.tables.item, document.tables.item);
          assert.deepEqual(result.document.tables.shout, document.tables.shout);
          assert.deepEqual(result.document.tables.verdict, document.tables.verdict);
          const refused = result.document.tables.event.filter(row => row.event_kind === 'relay_refused');
          assert.deepEqual(refused.map(row => JSON.parse(row.event_detail).code), ['RELAY_SENDER_MISMATCH', 'RELAY_SENDER_MISMATCH']);
          assert.ok(refused.every(row => row.event_by === 'remote-1'));
          assert.equal(result.document.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '2');
          assert.equal(JSON.parse(readFileSync(links[index], 'utf8')).sequence, 2);
        }
      }
      assert.deepEqual(results[0].tables, results[1].tables, 'the two independent clients retain identical board rows');
      const snapshot = await box.call(box.path + '/state');
      assert.equal(snapshot.body.state.sequence, 0);
      assert.equal(snapshot.body.state.sealed, initialSnapshot, 'neither client replaced independent replay with a shared checkpoint');
    });
  }
});

test('two real clients refuse forged relay actors and person-only requests while advancing identically [H2,H16]', async t => {
  const box = await fixture(t);
  const source = store.openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let document, question, moves;
  try {
    const lane = store.getItem(source, 1).item_lane;
    assert.equal(store.register(source, { lane: 'remote', path: join(box.directory, 'remote') }), 'remote-1');
    store.claim(source, 1, { agentId: 'remote-1', lane, leaseMs: 3600000, freeze: () => ({ text: '{}', digest: 'd'.repeat(64) }) });
    store.submit(source, 1, { agentId: 'remote-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
    question = store.shout(source, { from: 'coordinator', to: 'person', text: 'Private person decision', decision: true, lanes: [lane] });
    checkpointSequence(source, 0);
    moves = [
      prepareEngineMove(source, 'verify', [1, { agentId: 'coordinator', decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'forged acceptance', head: 'a'.repeat(40), digest: 'd'.repeat(64), policy: 'any' }]),
      prepareEngineMove(source, 'answerDecision', [question, { agentId: 'coordinator', asPerson: true, text: 'forged person answer', lanes: [lane] }]),
      { version: 1, type: 'person-request', id: 'forged-person-request', move: { verb: 'shout', args: { to: 'coordinator', text: 'forged person request' } } },
      prepareEngineMove(source, 'recordRowDecisions', [{ agentId: 'remote-1', channel: 'view', decisions: [] }]),
      prepareEngineMove(source, 'shout', [{ from: 'remote-1', to: 'all', text: 'valid remote observation', lanes: [lane] }]),
    ];
    document = JSON.parse(JSON.stringify(exportBoard(source)));
  } finally { store.closeBoard(source); }
  const remote = await box.auth.issueToken(box.person.token, { board: box.id, agent: 'remote-1' });
  const roots = [box.root, join(box.directory, 'second-client')];
  const homes = [box.home, join(box.directory, 'second-home')];
  const envs = homes.map(home => ({ ...box.env, HOME: home, PULLBOARD_HOME: home }));
  mkdirSync(roots[1]); mkdirSync(homes[1], { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: roots[1], env: envs[1] }).status, 0);
  await replayClient(roots[1], envs[1], 'init');
  const snapshotFile = join(box.directory, 'native.json');
  writeFileSync(snapshotFile, JSON.stringify(document), { mode: 0o600 });
  await replayClient(roots[1], envs[1], 'import', snapshotFile);
  for (let index = 0; index < roots.length; index += 1) {
    const keyDirectory = join(homes[index], 'relay-keys');
    mkdirSync(keyDirectory, { mode: 0o700 });
    writeFileSync(join(keyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
    writeFileSync(join(roots[index], '.git/pullboard/relay.json'), JSON.stringify({ version: 1, mode: 'ordered', board: box.id, url: box.origin, repository: 'fixture/repository', token: box.person.token, sequence: 0, cursor: document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
  }
  /** Seal production-format records on this client; the relay stores only their opaque envelopes. */
  async function upload(value, kind, sequence, token = remote.token) {
    const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(value)), { boardId: box.id, kind, sequence })).toString('base64url');
    const reply = await box.call(box.path + (kind === 'snapshot' ? '/state' : kind === 'request' ? '/requests' : '/moves'), { method: kind === 'snapshot' ? 'PUT' : 'POST', token, body: { sequence, sealed } });
    assert.equal(reply.status, 200, 'the real relay accepts the opaque authorized upload');
  }
  await upload(document, 'snapshot', 0, box.person.token);
  for (let index = 0; index < moves.length; index += 1) await upload(moves[index], index === 2 ? 'request' : 'move', index + 1);
  const exported = await Promise.all(roots.map((root, index) => replayClient(root, envs[index], 'export')));
  assert.deepEqual(exported[0].tables, exported[1].tables, 'every replica keeps exactly the same rows and refusal receipts');
  const result = exported[0];
  assert.deepEqual(result.tables.item, document.tables.item, 'forged verification changes no item');
  assert.deepEqual(result.tables.verdict, document.tables.verdict, 'forged acceptance leaves the verdict unchanged');
  const newShouts = result.tables.shout.filter(row => row.shout_id > document.tables.shout.at(-1).shout_id);
  assert.equal(newShouts.length, 1, 'only the permitted observation creates a shout');
  assert.equal(newShouts[0].shout_from, 'remote-1');
  assert.equal(newShouts[0].shout_text, 'valid remote observation');
  const refused = result.tables.event.filter(row => row.event_kind === 'relay_refused');
  assert.equal(refused.length, 4);
  assert.ok(refused.every(row => row.event_by === 'remote-1'), 'the log attributes every attempted forgery to its authenticated sender');
  assert.deepEqual(refused.map(row => JSON.parse(row.event_detail).code), ['RELAY_SENDER_MISMATCH', 'RELAY_PERSON_ONLY', 'RELAY_PERSON_ONLY', 'RELAY_PERSON_ONLY']);
  assert.equal(JSON.parse(refused[0].event_detail).actor, 'coordinator');
  assert.equal(result.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '5');
  const log = await replayClient(roots[1], envs[1], 'log');
  assert.deepEqual(log.events.filter(row => row.event_kind === 'relay_refused'), refused, 'pullboard log exposes the sending agent and attempted actor');
  assert.deepEqual((await replayClient(roots[0], envs[0], 'export')).tables, result.tables, 'repeat catch-up does not duplicate refusals or actions');
});

test('two real clients enforce the verify policy captured in the item freeze [H16,O2]', { timeout: 240_000 }, async t => {
  const box = await fixture(t);
  const configPath = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.verify = { ...config.verify, policy: 'coordinator', family: 'require' };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  execFileSync('git', ['add', 'pullboard.json', 'SPEC.md'], { cwd: box.root, env: {
    ...box.env, GIT_AUTHOR_NAME: 'Policy Fixture', GIT_AUTHOR_EMAIL: 'policy@example.invalid',
    GIT_COMMITTER_NAME: 'Policy Fixture', GIT_COMMITTER_EMAIL: 'policy@example.invalid',
  } });
  execFileSync('git', ['commit', '-q', '-m', 'test(relay): pin verify fixture policy'], { cwd: box.root, env: {
    ...box.env, GIT_AUTHOR_NAME: 'Policy Fixture', GIT_AUTHOR_EMAIL: 'policy@example.invalid',
    GIT_COMMITTER_NAME: 'Policy Fixture', GIT_COMMITTER_EMAIL: 'policy@example.invalid',
  } });
  const lane = Object.keys(config.lanes)[0];
  const builder = join(box.directory, 'builder');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'builder-policy', builder, 'HEAD'], { cwd: box.root, env: box.env });
  /** Run native setup commands from the real linked builder worktree. */
  const runBuilder = (...args) => {
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), ...args, '--json'], { cwd: builder, env: box.env, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout || 'the real native CLI prepares a fresh claim under the pinned main policy');
    return JSON.parse(result.stdout);
  };
  const joined = runBuilder('join', lane, '--family', 'Builder Family');
  const builderId = joined.agent;
  assert.equal(typeof builderId, 'string');
  runBuilder('claim', '1');

  const source = store.openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: box.root, env: box.env, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: box.root, env: box.env, encoding: 'utf8' }).trim();
  let verifierSame;
  let verifierOther;
  let legacyDigest;
  try {
    const item = store.getItem(source, 1);
    const frozen = JSON.parse(item.item_frozen);
    assert.deepEqual(frozen.policy.verify, { policy: 'coordinator', family: 'require' }, 'fresh native freeze captures both values from committed main config');
    const legacyPolicy = { version: 99, commit: frozen.policy.commit, verify: { policy: 'bogus', family: 'off' } };
    const legacyText = JSON.stringify({ ...frozen, policy: legacyPolicy });
    legacyDigest = createHash('sha256').update(legacyText).digest('hex');
    store.refreeze(source, 1, { agentId: 'coordinator', freeze: () => ({ text: legacyText, digest: legacyDigest }) });
  } finally { store.closeBoard(source); }

  const legacyRefreeze = box.cli('refreeze', '1');
  assert.match(legacyRefreeze, /#1 refrozen/);
  runBuilder('claim', '1');
  const afterRefreeze = store.openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let document;
  let moves;
  try {
    const refreshed = store.getItem(afterRefreeze, 1);
    assert.equal(JSON.parse(refreshed.item_frozen).policy.version, 1, 'explicit refreeze repairs malformed captured policy metadata');
    assert.deepEqual(JSON.parse(refreshed.item_frozen).policy.verify, { policy: 'coordinator', family: 'require' }, 'explicit native refreeze upgrades the legacy claim policy');
    assert.notEqual(refreshed.item_frozen_digest, legacyDigest, 'explicit refreeze establishes a new digest for the newly captured policy');
    store.submit(afterRefreeze, 1, { agentId: builderId, commit, tree, files: [] });
    store.register(afterRefreeze, { lane: 'coordinator', path: box.root, family: 'Coordinator Family' });
    store.register(afterRefreeze, { lane, path: join(box.directory, 'verifier-same'), family: 'Builder Family' });
    verifierSame = store.agentAt(afterRefreeze, join(box.directory, 'verifier-same')).agent_id;
    store.register(afterRefreeze, { lane, path: join(box.directory, 'verifier-other'), family: 'Reviewer Family' });
    verifierOther = store.agentAt(afterRefreeze, join(box.directory, 'verifier-other')).agent_id;

    /** Freeze test items with a specific historical policy document, keeping engine inputs deterministic. */
    const makeFrozen = (verify, version = 1) => item => {
      const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, policy: { version, commit, ...(verify ? { verify } : {}) } });
      return { text, digest: createHash('sha256').update(text).digest('hex') };
    };
    /** Add, claim and submit one private fixture item with the supplied frozen verify values. */
    const makeSubmitted = (title, verify, version = 1) => {
      const id = store.addItem(afterRefreeze, { by: 'coordinator', lane, title });
      store.claim(afterRefreeze, id, { agentId: builderId, lane, leaseMs: 3_600_000, freeze: makeFrozen(verify, version), head: commit });
      store.submit(afterRefreeze, id, { agentId: builderId, commit, tree, files: [] });
      return store.getItem(afterRefreeze, id);
    };
    const legacy = makeSubmitted('legacy frozen verify without policy capture', null);
    const sameFamily = makeSubmitted('require a different verifier family', { policy: 'any', family: 'require' });
    const crossFamily = makeSubmitted('allow a different verifier family', { policy: 'any', family: 'require' });
    const malformed = makeSubmitted('malformed captured verify policy', { policy: 'broken', family: 'off' });
    const wrongVersion = makeSubmitted('unsupported frozen policy version', { policy: 'any', family: 'require' }, 2);
    checkpointSequence(afterRefreeze, 0);
    document = JSON.parse(JSON.stringify(exportBoard(afterRefreeze)));
    /** Build a verifier envelope with deliberately untrusted any/off settings. */
    const forge = (item, agentId, id) => prepareEngineMove(afterRefreeze, 'verify', [item.item_id, {
      agentId, decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'checked by the fixture verifier',
      head: commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off',
    }], { id });
    moves = [
      forge(refreshed, verifierSame, 'forged_coordinator_policy'),
      forge(legacy, verifierSame, 'missing_frozen_verify_policy'),
      forge(sameFamily, verifierSame, 'forged_family_policy'),
      forge(crossFamily, verifierOther, 'allowed_cross_family_verify'),
      forge(malformed, verifierSame, 'malformed_frozen_verify_policy'),
      forge(wrongVersion, verifierSame, 'unsupported_frozen_policy_version'),
      forge(refreshed, 'coordinator', 'compliant_legacy_refreeze_verify'),
    ];
  } finally { store.closeBoard(afterRefreeze); }

  const roots = [box.root, join(box.directory, 'second-policy-client')];
  const homes = [box.home, join(box.directory, 'second-policy-home')];
  const envs = homes.map(home => ({ ...box.env, HOME: home, PULLBOARD_HOME: home }));
  mkdirSync(roots[1]); mkdirSync(homes[1], { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: roots[1], env: envs[1] }).status, 0);
  await replayClient(roots[1], envs[1], 'init');
    const snapshotFile = join(box.directory, 'policy-snapshot.json');
  writeFileSync(snapshotFile, JSON.stringify(document), { mode: 0o600 });
  await replayClient(roots[1], envs[1], 'import', snapshotFile);
  const recipientConfig = JSON.parse(readFileSync(join(roots[1], 'pullboard.json'), 'utf8'));
  assert.notDeepEqual(recipientConfig.verify, { policy: 'coordinator', family: 'require' }, 'second client has different local settings from the frozen shared policy');
  for (let index = 0; index < roots.length; index += 1) {
    const keyDirectory = join(homes[index], 'relay-keys');
    mkdirSync(keyDirectory, { mode: 0o700 });
    writeFileSync(join(keyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
    writeFileSync(join(roots[index], '.git/pullboard/relay.json'), JSON.stringify({ version: 1, mode: 'ordered', board: box.id, url: box.origin, repository: 'fixture/repository', token: box.person.token, sequence: 0, cursor: document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
  }
  const snapshotSealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(document)), { boardId: box.id, kind: 'snapshot', sequence: 0 })).toString('base64url');
  const savedSnapshot = await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: snapshotSealed } });
  assert.equal(savedSnapshot.status, 200, 'person session installs the initial encrypted snapshot');
  const verifierTokens = new Map();
  for (const agent of new Set([verifierSame, verifierOther])) verifierTokens.set(agent, await box.auth.issueToken(box.person.token, { board: box.id, agent }));
  for (let index = 0; index < moves.length; index += 1) {
    const agent = moves[index].args[1].agentId;
    const sequence = index + 1;
    const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(moves[index])), { boardId: box.id, kind: 'move', sequence })).toString('base64url');
    const token = agent === 'coordinator' ? box.person.token : verifierTokens.get(agent).token;
    const uploaded = await box.call(box.path + '/moves', { method: 'POST', token, body: { sequence, sealed } });
    assert.equal(uploaded.status, 200, 'the real relay accepts each authenticated verifier move as an opaque envelope');
  }

  const firstClient = await replayClientWithoutCheckpoint(roots[0], envs[0]);
  assert.equal(firstClient.code, 0);
  assert.equal(firstClient.checkpointWrites, 1, 'first client attempted one local checkpoint, suppressed before relay storage');
  const relayAfterFirst = await box.call(box.path + '/state');
  assert.equal(relayAfterFirst.body.state.sequence, 0, 'the second client cannot inherit the first client checkpoint');
  const secondClient = await replayClientWithoutCheckpoint(roots[1], envs[1]);
  assert.equal(secondClient.code, 0);
  assert.equal(secondClient.checkpointWrites, 1, 'second client independently attempted its own checkpoint');
  const exported = [firstClient.document, secondClient.document];
  assert.deepEqual(exported[0].tables, exported[1].tables, 'both real clients replay the same refusal and board prefix');
  assert.deepEqual(exported[0].tables.item.filter(item => ![1, 4].includes(item.item_id)), document.tables.item.filter(item => ![1, 4].includes(item.item_id)), 'policy refusals change no refused item state');
  assert.equal(exported[0].tables.item.find(item => item.item_id === 1).item_status, 'verified', 'an actual legacy refreeze enables a compliant coordinator verification');
  assert.equal(exported[0].tables.item.find(item => item.item_id === 4).item_status, 'verified', 'a different declared family is allowed under the frozen require policy');
  assert.equal(exported[0].tables.verdict.length, document.tables.verdict.length + 2, 'only compliant coordinator and cross-family verifications create verdicts');
  const codes = ['forged_coordinator_policy', 'missing_frozen_verify_policy', 'forged_family_policy', 'malformed_frozen_verify_policy', 'unsupported_frozen_policy_version'];
  const outcomes = [];
  for (const result of exported) {
    assert.equal(result.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '7');
    outcomes.push(codes.map(id => JSON.parse(result.tables.board_meta.find(row => row.meta_key === 'relay_receipt_' + id).meta_value).outcome.error.code));
    const accepted = JSON.parse(result.tables.board_meta.find(row => row.meta_key === 'relay_receipt_allowed_cross_family_verify').meta_value);
    assert.equal(accepted.outcome.result.decision, 'ACCEPT');
    const refrozen = JSON.parse(result.tables.board_meta.find(row => row.meta_key === 'relay_receipt_compliant_legacy_refreeze_verify').meta_value);
    assert.equal(refrozen.outcome.result.decision, 'ACCEPT');
  }
  assert.deepEqual(outcomes, [
    ['COORDINATOR_VERIFIES', 'NO_POLICY', 'O2_FAMILY_MATCH', 'NO_POLICY', 'NO_POLICY'],
    ['COORDINATOR_VERIFIES', 'NO_POLICY', 'O2_FAMILY_MATCH', 'NO_POLICY', 'NO_POLICY'],
  ]);
});

test('relay accepts engine 4 clients carrying sealed background completions [V2,H16]', async t => {
  const box = await fixture(t);
  const headers = { 'x-pullboard-engine': '4' };
  assert.ok(ENGINE_VERSION >= 4, 'engine-4 background completions remain supported');
  const snapshot = await box.call(box.path + '/state', {
    method: 'PUT', token: box.person.token, headers,
    body: { sequence: 0, sealed: box.clientSeal(box.document, 'snapshot', 0) },
  });
  assert.equal(snapshot.status, 200);
  const board = store.openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let move;
  try {
    const expected = { command: 'true', main: 'a'.repeat(40), request: '12345678-1234-1234-1234-123456789abc' };
    const prepared = prepareEngineMove(board, 'completeCheckBaseline', [1, {
      agentId: 'client-one', expected, baseline: { ...expected, result: 'green' },
    }]);
    assert.equal(prepared.engine, ENGINE_VERSION, 'new operations declare the current engine');
    move = { ...prepared, engine: 4 }; // Keep exercising the original engine-4 client.
    assert.equal(move.engine, 4);
  } finally { store.closeBoard(board); }
  const uploaded = await box.call(box.path + '/moves', {
    method: 'POST', headers, body: { sequence: 1, sealed: box.clientSeal(move, 'move', 1) },
  });
  assert.equal(uploaded.status, 200);
  const read = await box.call(box.path + '/events?after=0', { token: box.two.token, headers });
  assert.equal(read.status, 200);
  assert.equal(read.body.events.length, 1);
  const [record] = read.body.events;
  assert.deepEqual(record.sender, { kind: 'agent', userId: box.person.user.id, agent: 'client-one' });
  assert.deepEqual(box.clientOpen(record.sealed, record.kind, record.event_id), move);
});

test('[A4,H7] two clients append sealed moves in one order and no plaintext or client key reaches storage', async (t) => {
  const box = await fixture(t);
  const listed = await box.call('/api/v1/boards');
  assert.equal(listed.status, 200);
  const linkedAt = box.auth.linkedBoards().find(row => row.id === box.id).linkedAt;
  assert.deepEqual(listed.body.boards, [{ id: box.id, repository: 'fixture/repository', linkedAt }]);
  const initial = box.clientSeal(box.document, 'snapshot', 0);
  const uploaded = await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: initial } });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.version, 1);
  assert.deepEqual(uploaded.body.state.sender, { kind: 'person', userId: box.person.user.id });
  assert.deepEqual(box.clientOpen(uploaded.body.state.sealed, 'snapshot', 0), box.document);
  const sent = [
    { client: 'one', title: 'PRIVATE_MOVE_FROM_CLIENT_ONE' },
    { client: 'two', title: 'PRIVATE_MOVE_FROM_CLIENT_TWO' },
  ];
  const results = await Promise.all(sent.map((move, index) => box.call(box.path + '/moves', {
    method: 'POST', token: index ? box.two.token : box.one.token, body: { sequence: 1, sealed: box.clientSeal(move, 'move', 1) },
  })));
  assert.equal(results.filter((reply) => reply.status === 200).length, 1);
  const loser = results.findIndex((reply) => reply.status === 409);
  assert.notEqual(loser, -1);
  assert.equal(results[loser].body.error.code, 'SEQUENCE_REPEAT');
  const retry = await box.call(box.path + '/moves', {
    method: 'POST', token: loser ? box.two.token : box.one.token,
    body: { sequence: 2, sealed: box.clientSeal(sent[loser], 'move', 2) },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.event.event_id, 2);
  const read = await box.call(box.path + '/events?after=0');
  assert.deepEqual(read.body.events.map((row) => row.event_id), [1, 2]);
  assert.deepEqual(read.body.events.map((row) => box.clientOpen(row.sealed, row.kind, row.event_id)).sort((a, b) => a.client.localeCompare(b.client)), sent);
  const bytes = Buffer.concat(readdirSync(box.data).map((file) => readFileSync(join(box.data, file))));
  for (const text of [box.marker, ...sent.map((move) => move.title), box.root]) {
    assert.equal(bytes.includes(Buffer.from(text)), false, 'a known client plaintext must never occur in relay database bytes');
  }
  assert.equal(bytes.includes(box.key), false, 'the client key must never occur in relay database bytes');
  assert.deepEqual(JSON.parse(box.cli('export')), box.document, 'the complete local board remains unchanged');
});

test('[A4,H7] snapshots compact covered moves, preserve the tail and deletion removes only its database', async (t) => {
  const box = await fixture(t);
  await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: box.clientSeal(box.document, 'snapshot', 0) } });
  for (let n = 1; n <= 3; n++) {
    const reply = await box.call(box.path + '/moves', { method: 'POST', body: { sequence: n, sealed: box.clientSeal({ move: n }, 'move', n) } });
    assert.equal(reply.body.event.event_id, n);
  }
  const compacted = await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 2, sealed: box.clientSeal({ covered: 2 }, 'snapshot', 2) } });
  assert.equal(compacted.status, 200);
  assert.equal(compacted.body.state.sequence, 2);
  assert.deepEqual(box.clientOpen((await box.call(box.path + '/state')).body.state.sealed, 'snapshot', 2), { covered: 2 });
  const oldCursor = await box.call(box.path + '/events?after=0');
  assert.equal(oldCursor.status, 409);
  assert.equal(oldCursor.body.error.code, 'SNAPSHOT_REQUIRED');
  assert.deepEqual((await box.call(box.path + '/events?after=2')).body.events.map((row) => row.event_id), [3]);
  const next = await box.call(box.path + '/moves', { method: 'POST', body: { sequence: 4, sealed: box.clientSeal({ move: 4 }, 'move', 4) } });
  assert.equal(next.body.event.event_id, 4);
  const other = 'f'.repeat(32) === box.id ? 'e'.repeat(32) : 'f'.repeat(32);
  await box.auth.linkBoard(box.person.token, other, 'fixture/repository');
  const otherPath = '/api/v1/boards/' + other;
  assert.equal((await box.call(otherPath + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: box.clientSeal({ other: true }, 'snapshot', 0, other) } })).status, 200);
  assert.equal((await box.call(box.path, { method: 'DELETE', token: box.person.token })).status, 200);
  for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(join(box.data, box.id + '.journal.sqlite' + suffix)), false);
  assert.equal((await box.call(box.path + '/state', { token: box.person.token })).status, 404);
  assert.equal((await box.call(box.path + '/state')).status, 401, 'unlink revokes board-scoped credentials');
  assert.deepEqual(box.clientOpen((await box.call(otherPath + '/state', { token: box.person.token })).body.state.sealed, 'snapshot', 0, other), { other: true });
  assert.deepEqual(JSON.parse(box.cli('export')), box.document);
});

test('[A4,H7] malformed or unauthorized calls cannot store clear records, keys or another board', async (t) => {
  const box = await fixture(t);
  assert.equal((await box.call(box.path + '/state', { token: null })).status, 401);
  const other = 'b'.repeat(32) === box.id ? 'c'.repeat(32) : 'b'.repeat(32);
  const wrong = await box.call('/api/v1/boards/' + other + '/state');
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'TOKEN_BOARD');
  for (const body of [{ sequence: 0, sealed: 'a' }, { sequence: 0, sealed: 'abc=' }, { sequence: 0, sealed: box.clientSeal({}, 'snapshot', 0), key: 'client key stays on device' }, { sequence: '0', sealed: box.clientSeal({}, 'snapshot', 0) }]) {
    assert.equal((await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body })).status, 400);
  }
  assert.deepEqual(readdirSync(box.data), []);
  await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: box.clientSeal(box.document, 'snapshot', 0) } });
  assert.equal((await box.call(box.path + '/moves', { method: 'POST', body: { verb: 'add', args: { title: 'clear' } } })).body.error.code, 'BAD_UPLOAD');
  const deniedCookie = await box.call(box.path + '/moves', { method: 'POST', token: null, headers: { cookie: 'pb_session=' + box.person.token, origin: 'https://foreign.example' }, body: { sequence: 1, sealed: box.clientSeal({}, 'move', 1) } });
  assert.equal(deniedCookie.status, 403);
  assert.equal(deniedCookie.body.error.code, 'BAD_ORIGIN');
  assert.equal((await box.call(box.path + '/state', { token: null, headers: { cookie: 'pb_session=' + box.person.token } })).status, 200);
  const cookieMove = await box.call(box.path + '/moves', { method: 'POST', token: null, headers: { cookie: 'pb_session=' + box.person.token, origin: 'http://127.0.0.1:44444' }, body: { sequence: 1, sealed: box.clientSeal({ cookie: true }, 'move', 1) } });
  assert.equal(cookieMove.status, 200);
  const request = await box.call(box.path + '/requests', {
    method: 'POST', body: { sequence: 2, sealed: box.clientSeal({ request: true }, 'request', 2) },
  });
  assert.equal(request.status, 200);
  assert.equal(request.body.event.kind, 'request');
  assert.deepEqual(request.body.event.sender, { kind: 'agent', userId: box.person.user.id, agent: 'client-one' });
  assert.deepEqual(box.clientOpen(request.body.event.sealed, request.body.event.kind, request.body.event.event_id), { request: true });
  assert.throws(() => box.clientOpen(request.body.event.sealed, 'move', request.body.event.event_id));

  const gap = await box.call(box.path + '/moves', {
    method: 'POST', body: { sequence: 4, sealed: box.clientSeal({ gap: true }, 'move', 4) },
  });
  assert.equal(gap.status, 409);
  assert.equal(gap.body.error.code, 'SEQUENCE_GAP');
  assert.deepEqual((await box.call(box.path + '/events?after=0')).body.events.map((row) => row.event_id), [1, 2]);
  assert.equal((await box.call(box.path + '/state', {
    token: null, headers: { cookie: 'pb_session=' + box.person.token + '; pb_session=' + box.person.token },
  })).status, 401);
  await box.auth.revoke(box.person.token, box.one.id);
  assert.equal((await box.call(box.path + '/state')).status, 401);
});

test('[A4,H2,H7,H16] trusted sender attribution exposes impersonation and agent tokens cannot erase a board', async (t) => {
  const box = await fixture(t);
  const initial = box.clientSeal(box.document, 'snapshot', 0);
  const uploaded = await box.call(box.path + '/state', {
    method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: initial },
  });
  assert.equal(uploaded.status, 200);
  const forged = { agent: 'client-two', verb: 'claim', item: 1 };
  const reply = await box.call(box.path + '/moves', {
    method: 'POST', body: { sequence: 1, sealed: box.clientSeal(forged, 'move', 1) },
  });
  assert.equal(reply.status, 200, 'the relay stores opaque bytes without reading their claimed agent');
  const expected = { kind: 'agent', userId: box.person.user.id, agent: 'client-one' };
  assert.deepEqual(reply.body.event.sender, expected, 'the sender comes from the credential, not sealed contents');
  const events = (await box.call(box.path + '/events?after=0')).body.events;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].sender, expected, 'attribution survives the closed/reopened journal');
  const opened = box.clientOpen(events[0].sealed, events[0].kind, events[0].event_id);
  assert.notEqual(opened.agent, events[0].sender.agent, 'the client can detect impersonation before engine replay');
  assert.deepEqual(opened, forged, 'the server never rewrites or interprets the sealed move');

  const compact = await box.call(box.path + '/state', {
    method: 'PUT', body: { sequence: 1, sealed: box.clientSeal({ covered: 1 }, 'snapshot', 1) },
  });
  assert.equal(compact.status, 403);
  assert.equal(compact.body.error.code, 'HUMAN_REQUIRED');
  const deleted = await box.call(box.path, { method: 'DELETE' });
  assert.equal(deleted.status, 403);
  assert.equal(deleted.body.error.code, 'HUMAN_REQUIRED');
  assert.deepEqual((await box.call(box.path + '/state')).body.state, uploaded.body.state);
  assert.deepEqual((await box.call(box.path + '/events?after=0')).body.events, events);
  assert.ok(existsSync(join(box.data, box.id + '.journal.sqlite')));
  const personMove = await box.call(box.path + '/moves', {
    method: 'POST', token: box.person.token,
    body: { sequence: 2, sealed: box.clientSeal({ person: true }, 'move', 2) },
  });
  assert.deepEqual(personMove.body.event.sender, { kind: 'person', userId: box.person.user.id });
  assert.equal((await box.call(box.path, { method: 'DELETE', token: box.person.token })).status, 200);
});

test('[A4,H7] live streams follow the same order, resume by cursor and stop after revocation', async (t) => {
  const box = await fixture(t);
  await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: box.clientSeal(box.document, 'snapshot', 0) } });
  const controllers = [];
  t.after(() => { for (const controller of controllers) controller.abort(); });
  /** Open a live API stream and bound each observation without exposing its credential. */
  async function stream(last = null) {
    const controller = new AbortController();
    controllers.push(controller);
    const reply = await fetch(box.origin + box.path + '/events?after=0', {
      headers: { 'x-pullboard-engine': '3', authorization: 'Bearer ' + box.two.token, accept: 'text/event-stream', ...(last === null ? {} : { 'last-event-id': String(last) }) },
      signal: controller.signal,
    });
    assert.equal(reply.status, 200);
    const reader = reply.body.getReader();
    let text = '';
    /** Wait only until the requested synthetic cursor or refusal appears. */
    async function until(fragment) {
      const deadline = Date.now() + 3000;
      while (!text.includes(fragment)) {
        let timer;
        const part = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('sealed stream timed out')), Math.max(1, deadline - Date.now())); }),
        ]).finally(() => clearTimeout(timer));
        assert.equal(part.done, false, 'stream ended before expected delivery');
        text += Buffer.from(part.value).toString('utf8');
      }
      return text;
    }
    return { until, cancel: () => reader.cancel() };
  }
  const first = await stream();
  await first.until(': API v1\n');
  const one = await box.call(box.path + '/moves', { method: 'POST', body: { sequence: 1, sealed: box.clientSeal({ live: 1 }, 'move', 1) } });
  assert.equal(one.body.event.event_id, 1);
  const firstText = await first.until('id: 1\n');
  assert.ok(firstText.includes(JSON.stringify({ version: 1, event: one.body.event })));
  const resumed = await stream(1);
  await resumed.until(': API v1\n');
  const two = await box.call(box.path + '/moves', { method: 'POST', body: { sequence: 2, sealed: box.clientSeal({ live: 2 }, 'move', 2) } });
  assert.equal(two.body.event.event_id, 2);
  const resumedText = await resumed.until('id: 2\n');
  assert.equal(resumedText.includes('id: 1\n'), false);
  await box.auth.revoke(box.person.token, box.two.id);
  const revoked = await resumed.until('event: error\n');
  assert.ok(revoked.includes('"code":"AUTH_REQUIRED"'));
  await first.cancel();
  await resumed.cancel();
});

test('[A4,H7] a bounded large sealed snapshot is independent of the smaller move-body limit', async (t) => {
  const box = await fixture(t);
  const document = { record: 'a'.repeat(150_000) };
  const uploaded = await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: box.clientSeal(document, 'snapshot', 0) } });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(box.clientOpen(uploaded.body.state.sealed, 'snapshot', 0), document);
  const oversizeMove = await box.call(box.path + '/moves', { method: 'POST', body: { sequence: 1, sealed: box.clientSeal(document, 'move', 1) } });
  assert.equal(oversizeMove.status, 400);
  assert.equal(oversizeMove.body.error.code, 'BAD_REQUEST');
  assert.deepEqual((await box.call(box.path + '/events?after=0')).body.events, []);
  const packageInfo = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
  assert.equal(packageInfo.files.some((entry) => entry === 'relay' || entry.startsWith('relay/')), false);
});
