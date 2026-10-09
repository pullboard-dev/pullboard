/** Real device-flow CLI ordering through the opaque relay [H1,H7,H15]. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createAuthHandler } from '../relay/auth-http.js';
import { createRelayAuth } from '../relay/auth.js';
import { createRelayHandler } from '../relay/service.js';
import { createGitHubClient } from '../relay/github.js';
import { decodeBoardKey, encodeBoardKey, generateBoardKey, seal, unseal } from '../src/seal.js';
import { githubFixture } from './relay-fixture.js';
import * as store from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { checkpointSequence } from '../src/engine.js';
import { serveApi } from '../src/api.js';
import { main } from '../src/cli.js';
import { appliedSequence, prepareEngineMove } from '../src/engine.js';
import { storeBoardKey } from '../src/relay-key.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { presentationShout } from '../src/relay-presentation.js';

const SIGN_INS = new Map();

/** Run the actual CLI asynchronously so this process can continue serving its HTTP requests. */
function cliResult(root, env, ...args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), ...args, '--json'], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    let signInStarted = false;
    child.stderr.setEncoding('utf8').on('data', (part) => {
      stderr += part;
      if (!signInStarted && stderr.includes('enter TEST-ONLY') && SIGN_INS.has(root)) {
        signInStarted = true;
        Promise.resolve(SIGN_INS.get(root)()).catch(() => child.kill('SIGKILL'));
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`pullboard ${args.join(' ')} was killed by ${signal}: ${stderr}`));
      try { resolveResult({ status: code, document: JSON.parse(stdout), stderr }); }
      catch { reject(new Error(`pullboard ${args.join(' ')} did not print JSON: ${stdout}\n${stderr}`)); }
    });
  });
}

/** Run a successful actual CLI command and retain refusal diagnostics on failure. */
async function cli(root, env, ...args) {
  const result = await cliResult(root, env, ...args);
  assert.equal(result.status, 0, `pullboard ${args.join(' ')} exited ${result.status}: ${result.stderr}\n${JSON.stringify(result.document)}`);
  return result.document;
}

/** Read local events directly so inspection itself cannot drain the durable retry queue. */
function localEvents(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return JSON.parse(JSON.stringify(db.prepare('SELECT * FROM event ORDER BY event_id').all())); }
  finally { db.close(); }
}

/** Run the real auth and opaque board handlers together on a private loopback port. */
async function relayServer(t, directory, auth) {
  let signIn;
  let api;
  let refuseMoves = false;
  let loseReply = false;
  let refuseReads = false;
  let blockAfterDrop = false;
  let now = Date.now();
  const calls = [];
  const uploads = [];
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, path: req.url });
    if (req.method === 'POST' && /\/moves$/.test(req.url)) {
      const drop = loseReply;
      loseReply = false;
      const end = res.end.bind(res);
      res.end = (chunk, ...args) => {
        const document = JSON.parse(String(chunk));
        if (document.event) uploads.push({ sequence: document.event.event_id, sealed: document.event.sealed });
        if (drop && document.event) { refuseReads = blockAfterDrop; res.destroy(); return res; }
        return end(chunk, ...args);
      };
    }
    if (refuseReads && req.method === 'GET' && /\/events\?/.test(req.url)) {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"version":1,"error":{"code":"TEMPORARY","message":"retry","next":"retry"}}');
      return;
    }
    if (refuseMoves && req.method === 'POST' && /\/api\/v1\/boards\/[^/]+\/moves$/.test(req.url)) {
      for await (const _chunk of req) { /* consume sealed bytes without logging them */ }
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"version":1,"error":{"code":"TEMPORARY","message":"retry","next":"retry"}}');
      return;
    }
    if (await signIn(req, res)) return;
    await api(req, res);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((ready, reject) => {
    server.once('listening', ready);
    server.once('error', reject);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  signIn = createAuthHandler({ auth, publicOrigin: origin });
  api = createRelayHandler({ directory, auth, publicOrigin: origin, pollMs: 10, maintenanceMs: 0, now: () => now });
  t.after(async () => {
    api.close();
    server.closeAllConnections();
    await new Promise((ready) => server.close(ready));
  });
  return { origin, calls, uploads, failMoves(value) { refuseMoves = value; }, dropNextReply({ offline = false } = {}) { loseReply = true; blockAfterDrop = offline; }, failReads(value) { refuseReads = value; }, advance(days) { now = Date.now() + days * 86400000; } };
}

test('[H1,H3,H7,H15,H16] relay on snapshots and orders ciphertext, refuses offline moves, and off preserves the board', async (t) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-relay-client-')));
  const root = join(scratch, 'repo');
  const home = join(scratch, 'home');
  const pullboardHome = join(home, '.pullboard');
  const privateBin = join(scratch, 'path');
  const relayDirectory = join(scratch, 'relay');
  mkdirSync(root); mkdirSync(home, { mode: 0o700 }); mkdirSync(privateBin, { mode: 0o700 });
  chmodSync(home, 0o700); chmodSync(privateBin, 0o700);
  const gitBinary = process.env.PATH.split(delimiter).map((entry) => join(entry, 'git')).find(existsSync);
  assert.ok(gitBinary, 'the fixture PATH contains git');
  symlinkSync(realpathSync(gitBinary), join(privateBin, 'git'));
  symlinkSync(realpathSync(process.execPath), join(privateBin, 'node'));
  symlinkSync(realpathSync('/bin/sh'), join(privateBin, 'sh'));
  const env = {
    ...process.env,
    HOME: home,
    PULLBOARD_HOME: pullboardHome,
    PATH: privateBin,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Relay Test',
    GIT_AUTHOR_EMAIL: 'relay-test@example.com',
    GIT_COMMITTER_NAME: 'Relay Test',
    GIT_COMMITTER_EMAIL: 'relay-test@example.com',
  };
  const provider = await githubFixture(t);
  let signIns = 0;
  SIGN_INS.set(root, async () => {
    signIns++;
    assert.equal((await fetch(provider.origin + '/login/device')).status, 200);
  });
  t.after(() => SIGN_INS.delete(root));
  const auth = createRelayAuth({ database: join(scratch, 'auth.sqlite'), github: createGitHubClient(provider.config) });
  t.after(() => { auth.close(); });
  const relay = await relayServer(t, relayDirectory, auth);
  t.after(() => { rmSync(scratch, { recursive: true, force: true }); });
  const flow = auth.beginWeb();
  const authorization = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location'));
  const person = await auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), flow.binding);

  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  await cli(root, env, 'init');
  writeFileSync(join(root, 'SPEC.md'), '# Spec\n\n## G · Goals\n- G1 [approved, must] A lost reply has one original outcome. | gate: review\n');
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  const originRemote = spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(originRemote.status, 0, originRemote.stderr);
  const marker = 'RELAY_CLIENT_KNOWN_PRIVATE_CRITERION';
  const lane = Object.keys(config.lanes)[0];
  await cli(root, env, 'add', lane, 'initial private item', '--criterion', marker);
  const oldHistoryText = 'RELAY_PRIVATE_OLD_HISTORY_SHOUT_000';
  const boardFile = join(root, '.git', 'pullboard', 'board.sqlite');
  const board = store.openBoard(boardFile);
  const lanes = Object.keys(config.lanes);
  let oldestShoutId;
  try {
    for (let index = 0; index < 41; index += 1) {
      const id = store.shout(board, { from: 'coordinator', to: 'person', text: index === 0 ? oldHistoryText : `old private history ${index}`, lanes });
      if (index === 0) oldestShoutId = id;
    }
  } finally {
    store.closeBoard(board);
  }
  const beforeLink = await cli(root, env, 'export');
  const boardId = beforeLink.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value;

  const relayEnv = env;
  assert.deepEqual(relay.calls, [], 'unlinked commands open no relay connection');
  const keysDirectory = join(pullboardHome, 'relay-keys');
  mkdirSync(keysDirectory, { recursive: true, mode: 0o755 });
  await assert.rejects(cli(root, relayEnv, 'relay', 'on', '--url', relay.origin), /RELAY_KEY_STORAGE/);
  assert.deepEqual(await auth.boardsFor(person.token), [], 'a failed device key save creates no remote link');
  assert.ok(!relay.calls.some((call) => call.path === '/auth/boards/link'));
  chmodSync(keysDirectory, 0o700);
  const on = await cli(root, relayEnv, 'relay', 'on', '--url', relay.origin);
  const linkedAt = auth.linkedBoards().find(link => link.id === boardId).linkedAt;
  assert.deepEqual(await auth.boardsFor(person.token), [{ id: boardId, repository: 'fixture/repository', linkedAt }]);
  assert.equal(on.version, 1);
  assert.equal(on.linked, true);
  assert.equal(on.board, boardId);
  assert.match(on.link, /^https:\/\/app\.pullboard\.dev\/#board=/);
  assert.match(on.link, /(?:^|&)key=[A-Za-z0-9_-]{43}(?:&|$)/);
  assert.equal(on.url, relay.origin);
  const keyFile = join(pullboardHome, 'relay-keys', `${boardId}.key`);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const keyText = readFileSync(keyFile, 'utf8').trim();
  const key = decodeBoardKey(keyText);
  const fragment = new URL(on.link).hash.slice(1);
  assert.equal(new URLSearchParams(fragment).get('board'), boardId);
  assert.equal(new URLSearchParams(fragment).get('key'), keyText, 'the phone link carries this board key only after #');

  /** Fetch a public sealed document and authenticate it locally with the device-only key. */
  async function get(path) {
    const response = await fetch(relay.origin + path, { headers: { 'x-pullboard-engine': '3', authorization: `Bearer ${person.token}` } });
    return { status: response.status, body: await response.json() };
  }
  const remoteState = await get(`/api/v1/boards/${boardId}/state`);
  assert.equal(remoteState.status, 200);
  const openedSnapshot = JSON.parse(new TextDecoder().decode(await unseal(
    key, Buffer.from(remoteState.body.state.sealed, 'base64url'), { boardId, kind: 'snapshot', sequence: 0 },
  )));
  const linkedExport = await cli(root, env, 'export');
  assert.deepEqual(openedSnapshot.tables, linkedExport.tables, 'the first sealed record is the exact native board snapshot');
  assert.ok(openedSnapshot.presentation.state.items.some((item) => item.title === 'initial private item'));
  assert.equal(openedSnapshot.presentation.state.shouts.length, 40, 'the view state remains bounded to the recent forty');
  assert.equal(openedSnapshot.presentation.shouts.length, 41, 'the sealed presentation retains full history for addressed reads');
  assert.equal(openedSnapshot.presentation.shouts[0].shout_text, oldHistoryText, 'the sealed history includes the oldest addressed shout');
  assert.equal(presentationShout(openedSnapshot.presentation, oldestShoutId).shout_text, oldHistoryText,
    'a receiver can resolve an old shout from decoded presentation data without opening the repository');
  for (const [table, rows] of Object.entries(beforeLink.tables)) {
    if (table !== 'board_meta') assert.deepEqual(openedSnapshot.tables[table], rows, 'linking preserves every existing board row');
  }

  await cli(root, relayEnv, 'add', lane, 'mirrored private move');
  await cli(root, relayEnv, 'shout', 'person', 'mirrored private shout');
  const firstMoves = localEvents(boardFile).slice(beforeLink.tables.event.length);
  assert.deepEqual(firstMoves.map((row) => row.event_kind), ['add', 'shout']);
  const nativeAfterMoves = await get(`/api/v1/boards/${boardId}/state`);
  assert.equal(nativeAfterMoves.body.state.sequence, 2, 'the checkpoint covers both acknowledged operations');
  const checkpoint = JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(nativeAfterMoves.body.state.sealed, 'base64url'), { boardId, kind: 'snapshot', sequence: 2 })));
  assert.deepEqual(checkpoint.tables.event.slice(beforeLink.tables.event.length), firstMoves);
  assert.ok(checkpoint.presentation.state.items.some((item) => item.title === 'mirrored private move'));
  assert.equal(relay.uploads.length, 2);
  for (const [index, upload] of relay.uploads.entries()) {
    assert.equal(upload.sequence, index + 1);
    const opened = JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(upload.sealed, 'base64url'), { boardId, kind: 'move', sequence: upload.sequence })));
    assert.equal(opened.engine, ENGINE_VERSION);
    assert.equal(opened.operation, ['addItem', 'shout'][index]);
    assert.ok(opened.id);
    assert.ok(Array.isArray(opened.args));
  }

  const linkFile = join(root, '.git', 'pullboard', 'relay.json');
  const oldLink = JSON.parse(readFileSync(linkFile, 'utf8'));
  await auth.revoke(person.token, oldLink.tokenId);
  const expired = await cli(root, relayEnv, 'status');
  assert.match((expired.diagnostics ?? []).join('\n'), /sign-in expired or was revoked.*relay on/);
  const renewed = await cli(root, relayEnv, 'relay', 'on');
  assert.equal(renewed.link, on.link, 'renewing sign-in preserves the device pairing key');
  assert.equal(renewed.sequence, 2, 'renewing sign-in preserves the relay cursor');
  assert.equal((await get(`/api/v1/boards/${boardId}/state`)).body.state.sealed, nativeAfterMoves.body.state.sealed,
    'renewing sign-in does not replace the acknowledged checkpoint');
  assert.ok(signIns >= 3, 'JSON mode exposes each device code before waiting for sign-in');

  relay.failMoves(true);
  const beforeOffline = localEvents(boardFile);
  const offlineMove = await cliResult(root, relayEnv, 'add', lane, 'queued private move');
  assert.equal(offlineMove.status, 1);
  assert.equal(offlineMove.document.error.code, 'TEMPORARY');
  assert.ok(offlineMove.document.error.message.includes(relay.origin), 'offline moves name the configured relay');
  assert.deepEqual(localEvents(boardFile), beforeOffline, 'no speculative local move precedes relay acknowledgement');
  const behind = await cli(root, relayEnv, 'status');
  assert.equal(behind.relay.behind, 0, 'a known refused send is not queued to execute later');
  relay.failMoves(false);
  const caughtUp = await cli(root, relayEnv, 'status');
  assert.equal(caughtUp.relay.behind, 0, 'the next reachable command recovers the durable send');
  const recoveredRows = localEvents(boardFile).slice(beforeOffline.length);
  assert.deepEqual(recoveredRows, [], 'offline refusal cannot become a later unsolicited move');
  const lostBrief = join(root, 'lost-brief.md');
  writeFileSync(lostBrief, 'The original lost-reply brief.\n');
  relay.dropNextReply({ offline: true });
  await assert.rejects(cli(root, relayEnv, 'add', lane, 'committed reply lost', '--specs', 'G1', '--brief-file', lostBrief), /RELAY_UNAVAILABLE/);
  const durableId = JSON.parse(readFileSync(linkFile, 'utf8')).pending.move.id;
  await cli(root, relayEnv, 'status');
  assert.equal(JSON.parse(readFileSync(linkFile, 'utf8')).pending.move.id, durableId,
    'offline reads preserve the exact uncertain operation id');
  relay.failReads(false);
  const recovered = await cli(root, relayEnv, 'status');
  assert.equal(recovered.relay.behind, 0);
  assert.equal(recovered.relay.sequence, 3);
  const different = await cliResult(root, relayEnv, 'add', lane, 'different interrupted intent');
  assert.equal(different.status, 1);
  assert.equal(different.document.error.code, 'RELAY_RETRY_PENDING');
  const sentBeforeRetry = relay.uploads.length;
  writeFileSync(join(root, 'SPEC.md'), '# Spec\n\n## G · Goals\n');
  rmSync(lostBrief);
  const repeated = await cli(root, relayEnv, 'add', lane, 'committed reply lost', '--specs', 'G1', '--brief-file', lostBrief);
  assert.equal(repeated.item.item_brief, 'The original lost-reply brief.', 'an acknowledged retry does not re-read removed spec or brief files');
  writeFileSync(join(root, 'SPEC.md'), '# Spec\n\n## G · Goals\n- G1 [approved, must] A lost reply has one original outcome. | gate: review\n');
  assert.equal(repeated.item.item_title, 'committed reply lost');
  assert.equal(repeated.item.item_id, 3, 'retry reports the original allocated item id');
  assert.equal(relay.uploads.length, sentBeforeRetry, 'retry never creates another relay position');
  assert.equal(JSON.parse(readFileSync(linkFile, 'utf8')).recovered, undefined,
    'the original outcome is consumed only when its command reports it');
  const lostRows = localEvents(boardFile).filter((row) => row.event_kind === 'add');
  assert.equal(lostRows.length, 3, 'initial, ordered and lost-reply items each apply once');
  const uniqueMoves = new Set();
  for (const upload of relay.uploads) {
    const opened = JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(upload.sealed, 'base64url'), { boardId, kind: 'move', sequence: upload.sequence })));
    uniqueMoves.add(opened.id);
  }
  assert.equal(uniqueMoves.size, 3, 'a lost reply recovers the exact send without inventing a second operation');
  await legacyMirrorQueueFragment({ relay, root, relayEnv, boardFile, linkFile, lane, lanes: Object.keys(config.lanes), boardId, key,
    currentPersonToken: JSON.parse(readFileSync(linkFile, 'utf8')).token, localEvents, cli, store, unseal });
  relay.advance(80);
  const warned = await cli(root, relayEnv, 'status');
  assert.match((warned.diagnostics ?? []).join('\n'), /BOARD_INACTIVE.*10 days left.*Make a board move/i, 'the next linked command shows the real relay retention notice and repair');
  relay.advance(0);

  const stored = Buffer.concat(readdirSync(relayDirectory).map((name) => readFileSync(join(relayDirectory, name))));
  for (const secret of [marker, 'initial private item', oldHistoryText, 'mirrored private move', 'mirrored private shout', 'queued private move', 'second queued private move', 'committed reply lost', root]) {
    assert.equal(stored.includes(Buffer.from(secret)), false, `relay journal does not contain known plaintext ${secret}`);
  }
  assert.equal(stored.includes(key), false, 'relay journal does not contain raw key bytes');
  assert.equal(stored.includes(Buffer.from(encodeBoardKey(key))), false, 'relay journal does not contain the encoded key');

  await legacyForeignPrefixFragment({ relay, root, relayEnv, boardFile, linkFile, lane, boardId,
    currentPersonToken: JSON.parse(readFileSync(linkFile, 'utf8')).token, localEvents, cliResult });
  const localBeforeOff = await cli(root, relayEnv, 'export');
  const off = await cli(root, relayEnv, 'relay', 'off');
  assert.equal(off.linked, false);
  assert.deepEqual((await cli(root, env, 'export')).tables, localBeforeOff.tables, 'unlink leaves local rows and counters unchanged');
  assert.deepEqual(await auth.boardsFor(person.token), [], 'unlink removes the repository link');
  const session = await fetch(relay.origin + '/auth/session', { headers: { 'x-pullboard-engine': '3', authorization: `Bearer ${person.token}` } });
  assert.equal(session.status, 200, 'unlink preserves the person session');
  assert.equal((await get(`/api/v1/boards/${boardId}/state`)).status, 404);
  assert.equal(readdirSync(relayDirectory).some((name) => name.startsWith(boardId + '.journal.sqlite')), false,
    'off removes the relay journal and SQLite sidecars');
  const afterOffCalls = relay.calls.length;
  await cli(root, env, 'status');
  assert.equal(relay.calls.length, afterOffCalls, 'unlinked commands stop connecting immediately');
  assert.equal(existsSync(keyFile), false, 'successful off removes this device copy of the board key');
});

test('[H3,H16] three cloned linked replicas order competing claims and recover lost replies once', { timeout: 240_000 }, async (t) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-relay-clone-race-')));
  const seed = join(scratch, 'seed');
  const clones = [join(scratch, 'clone-a'), join(scratch, 'clone-b'), join(scratch, 'clone-c')];
  const worktrees = [join(scratch, 'work-a'), join(scratch, 'work-b'), join(scratch, 'work-c')];
  const homes = [join(scratch, 'home-a'), join(scratch, 'home-b'), join(scratch, 'home-c')];
  const privateBin = join(scratch, 'path');
  const relayDirectory = join(scratch, 'relay');
  mkdirSync(seed);
  mkdirSync(privateBin, { mode: 0o700 });
  for (const home of homes) mkdirSync(home, { mode: 0o700 });
  const gitBinary = process.env.PATH.split(delimiter).map((entry) => join(entry, 'git')).find(existsSync);
  assert.ok(gitBinary, 'the fixture PATH contains git');
  symlinkSync(realpathSync(gitBinary), join(privateBin, 'git'));
  symlinkSync(realpathSync(process.execPath), join(privateBin, 'node'));
  symlinkSync(realpathSync('/bin/sh'), join(privateBin, 'sh'));
  const envs = homes.map((home) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, PULLBOARD_HOME: join(home, '.pullboard'), PATH: privateBin };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    Object.assign(env, {
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Relay Clone Test', GIT_AUTHOR_EMAIL: 'relay-clone@example.com',
      GIT_COMMITTER_NAME: 'Relay Clone Test', GIT_COMMITTER_EMAIL: 'relay-clone@example.com',
    });
    return env;
  });

  /** Run fixture Git with an isolated identity and report its stderr on failure. */
  function gitAt(root, env, ...args) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** Resolve the common Git directory used by a clone and its worktree. */
  function commonDir(root, env) {
    return resolve(root, gitAt(root, env, 'rev-parse', '--git-common-dir'));
  }

  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  gitAt(seed, envs[0], 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'pullboard.json'), JSON.stringify({
    gate: 'true', lanes: { web: { owns: ['web/'], specs: ['G'] } },
  }, null, 2) + '\n');
  writeFileSync(join(seed, 'SPEC.md'), '# Spec\n\n## G · Goals: relay claim fixture\n- G1 [approved, must] A linked claim is applied once in relay order. | gate: review\n');
  writeFileSync(join(seed, 'PRACTICE.md'), readFileSync(resolve(import.meta.dirname, '..', existsSync(resolve(import.meta.dirname, '../DOCTRINE.md')) ? 'DOCTRINE.md' : 'PRACTICE.md')));
  mkdirSync(join(seed, 'web'));
  writeFileSync(join(seed, 'web', 'README.md'), 'relay claim fixture\n');
  gitAt(seed, envs[0], 'add', '-A');
  gitAt(seed, envs[0], 'commit', '-q', '-m', 'test: seed relay claim fixture');

  for (const clone of clones) gitAt(scratch, envs[0], 'clone', '-q', seed, clone);
  for (let index = 0; index < clones.length; index += 1) {
    gitAt(clones[index], envs[index], 'remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git');
    gitAt(clones[index], envs[index], 'worktree', 'add', '-q', '-b', `web/race-${index + 1}`, worktrees[index], 'main');
  }

  const seedBoard = store.openBoard(join(commonDir(seed, envs[0]), 'pullboard', 'board.sqlite'));
  let boardId;
  let snapshot;
  try {
    store.register(seedBoard, { lane: 'coordinator', path: seed });
    for (let index = 0; index < worktrees.length; index += 1) {
      store.register(seedBoard, { lane: 'web', path: worktrees[index], route: 'light' });
    }
    for (let id = 1; id <= 20; id += 1) {
      store.addItem(seedBoard, {
        by: 'coordinator', lane: 'web', title: `Concurrent claim ${id}`,
        criterion: 'one clone claims this item once', specIds: ['G1'],
        brief: 'Files: web/README.md\nTest: exactly one ordered claim event is recorded.', route: 'light', check: 'true',
      });
    }
    boardId = store.boardId(seedBoard);
    checkpointSequence(seedBoard, 0);
    snapshot = exportBoard(seedBoard);
  } finally { store.closeBoard(seedBoard); }

  for (let index = 0; index < clones.length; index += 1) {
    const replica = store.openBoard(join(commonDir(clones[index], envs[index]), 'pullboard', 'board.sqlite'));
    try { importBoard(replica, snapshot); } finally { store.closeBoard(replica); }
  }

  const provider = await githubFixture(t);
  const auth = createRelayAuth({ database: join(scratch, 'auth.sqlite'), github: createGitHubClient(provider.config) });
  t.after(() => auth.close());
  const relay = await relayServer(t, relayDirectory, auth);
  const flow = auth.beginWeb();
  const authorization = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location'));
  const person = await auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), flow.binding);
  await auth.linkBoard(person.token, boardId, 'fixture/repository');

  const key = await generateBoardKey();
  const savedPath = process.env.PATH;
  const savedHome = process.env.PULLBOARD_HOME;
  try {
    process.env.PATH = privateBin;
    for (let index = 0; index < clones.length; index += 1) {
      process.env.PULLBOARD_HOME = envs[index].PULLBOARD_HOME;
      assert.equal(storeBoardKey(boardId, key), 'file', 'the isolated PATH forces the private file fallback');
      const keyFile = join(envs[index].PULLBOARD_HOME, 'relay-keys', `${boardId}.key`);
      assert.equal(statSync(keyFile).mode & 0o777, 0o600);
      const state = {
        version: 1, mode: 'ordered', board: boardId, url: relay.origin, repository: 'fixture/repository',
        token: person.token, tokenId: person.id, keyStorage: 'file', sequence: 0,
        cursor: snapshot.tables.event.at(-1)?.event_id ?? 0,
      };
      const linkFile = join(commonDir(clones[index], envs[index]), 'pullboard', 'relay.json');
      writeFileSync(linkFile, JSON.stringify(state) + '\n', { mode: 0o600 });
      chmodSync(linkFile, 0o600);
    }
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = savedHome;
  }

  const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(snapshot)), {
    boardId, kind: 'snapshot', sequence: 0,
  })).toString('base64url');
  const uploaded = await fetch(`${relay.origin}/api/v1/boards/${boardId}/state`, {
    method: 'PUT', headers: { 'x-pullboard-engine': '3', authorization: `Bearer ${person.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: 0, sealed }),
  });
  assert.equal(uploaded.status, 200, await uploaded.text());

  const refusals = new Map();
  for (let id = 1; id <= 20; id += 1) {
    const [left, right] = await Promise.all([
      cliResult(worktrees[0], envs[0], 'claim', String(id)),
      cliResult(worktrees[1], envs[1], 'claim', String(id)),
    ]);
    const attempts = [left, right];
    assert.equal(attempts.filter((result) => result.status === 0).length, 1, `one clone claims #${id}`);
    const winner = attempts.findIndex((result) => result.status === 0);
    const loser = attempts[1 - winner];
    assert.equal(loser.status, 1, `the competing claim for #${id} is refused`);
    assert.equal(loser.document.error.code, 'HELD');
    assert.equal(typeof loser.document.error.message, 'string');
    assert.equal(typeof loser.document.error.next, 'string');
    refusals.set(id, loser.document.error);
    const released = await cliResult(worktrees[winner], envs[winner], 'release', String(id));
    assert.equal(released.status, 0, `the winner releases #${id} before the next round`);
  }

  const synced = await Promise.all(clones.map((clone, index) => cliResult(worktrees[index], envs[index], 'status')));
  assert.ok(synced.every((result) => result.status === 0), 'both replicas finish by applying the same relay prefix');

  /** Read replay receipts without changing either replica's event cursor. */
  function receipts(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'relay_receipt_%'")
        .all().map(({ meta_value }) => JSON.parse(meta_value));
    } finally { db.close(); }
  }

  const replicaFiles = clones.map((clone, index) => join(commonDir(clone, envs[index]), 'pullboard', 'board.sqlite'));
  const eventRows = replicaFiles.map((file) => localEvents(file));
  const receiptRows = replicaFiles.map(receipts);
  for (let id = 1; id <= 20; id += 1) {
    for (const events of eventRows) {
      assert.equal(events.filter((event) => event.item_id === id && event.event_kind === 'claim').length, 1,
        `item #${id} has exactly one applied claim event on each clone`);
    }
    for (const rows of receiptRows) {
      const claims = rows.map((receipt) => ({ receipt, move: JSON.parse(receipt.move) }))
        .filter(({ move }) => move.operation === 'claim' && move.args[0] === id);
      assert.equal(claims.length, 2, `both ordered claim descriptors for #${id} have durable receipts`);
      const denied = claims.filter(({ receipt }) => receipt.outcome.error);
      assert.equal(denied.length, 1, `exactly one durable claim receipt for #${id} is a refusal`);
      assert.deepEqual(denied[0].receipt.outcome.error, {
        code: refusals.get(id).code, message: refusals.get(id).message, next: refusals.get(id).next,
      }, `the durable refusal for #${id} matches the losing CLI result exactly`);
    }
  }
  assert.equal(receiptRows[0].length, receiptRows[1].length, 'both cloned boards retain the same number of applied operation receipts');

  relay.failMoves(true);
  const beforeWorktreeFailure = localEvents(replicaFiles[0]);
  const beforeWorktrees = gitAt(clones[0], envs[0], 'worktree', 'list', '--porcelain');
  const failedWorktree = await cliResult(clones[0], envs[0], 'worktree', 'web');
  assert.equal(failedWorktree.status, 1);
  assert.equal(failedWorktree.document.error.code, 'TEMPORARY');
  assert.equal(gitAt(clones[0], envs[0], 'worktree', 'list', '--porcelain'), beforeWorktrees,
    'a refused relay registration removes only its newly-created clean worktree');
  assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/web/1'], {
    cwd: clones[0], env: envs[0],
  }).status, 1, 'the unregistered new branch is removed too');
  assert.deepEqual(localEvents(replicaFiles[0]), beforeWorktreeFailure, 'registration never runs locally before sequencing');
  relay.failMoves(false);
  await cli(clones[0], envs[0], 'status');

  const beforeInit = localEvents(replicaFiles[0]);
  const initializedClone = await cli(clones[0], envs[0], 'init');
  assert.equal(initializedClone.root, clones[0]);
  assert.deepEqual(localEvents(replicaFiles[0]), beforeInit, 'repeated init cannot bypass relay ordering to rewrite coordinator registration');

  const board = store.openBoard(replicaFiles[0]);
  let earlier;
  let next;
  try {
    next = appliedSequence(board) + 1;
    earlier = prepareEngineMove(board, 'addItem', [{ by: 'coordinator', lane: 'web', title: 'Earlier remote item' }]);
  } finally { store.closeBoard(board); }
  const earlierSealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(earlier)), {
    boardId, kind: 'move', sequence: next,
  })).toString('base64url');
  const headers = { 'x-pullboard-engine': '3', authorization: `Bearer ${person.token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${relay.origin}/api/v1/boards/${boardId}/moves`, {
    method: 'POST', headers, body: JSON.stringify({ sequence: next, sealed: earlierSealed }),
  })).status, 200);

  /** Run the actual local API command under this clone's isolated device credentials. */
  async function apiCommand(argv, io) {
    const names = ['PATH', 'HOME', 'PULLBOARD_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = envs[0][name];
      return await main(argv, io);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  }
  const localApi = await serveApi({ runCommand: apiCommand, projects: () => [{ root: clones[0], name: 'Clone API' }] });
  try {
    const address = new URL(localApi.url);
    const response = await fetch(`${address.origin}/api/v1/boards/${boardId}/moves`, {
      method: 'POST', headers: { 'x-pullboard-key': address.searchParams.get('k'), 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'add', args: { lane: 'web', title: 'This API item' } }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.event.event_kind, 'add');
    assert.equal(result.event.item_id, result.result.item.item_id, 'the API returns its own event despite catching up an earlier add');
    assert.equal(result.result.item.item_title, 'This API item');

    const apiLostTitle = 'Lost API reply';
    const apiLostBody = JSON.stringify({ verb: 'add', args: { lane: 'web', title: apiLostTitle } });
    const apiLostHeaders = { 'x-pullboard-key': address.searchParams.get('k'), 'content-type': 'application/json' };
    const beforeLostApi = relay.uploads.length;
    relay.dropNextReply({ offline: true });
    const lostApi = await fetch(`${address.origin}/api/v1/boards/${boardId}/moves`, {
      method: 'POST', headers: apiLostHeaders, body: apiLostBody,
    });
    const lostApiResult = await lostApi.json();
    assert.equal(lostApi.status, 409, JSON.stringify(lostApiResult));
    assert.equal(lostApiResult.error.code, 'RELAY_UNAVAILABLE');
    relay.failReads(false);
    await cli(clones[0], envs[0], 'status');
    const apiRetry = await fetch(`${address.origin}/api/v1/boards/${boardId}/moves`, {
      method: 'POST', headers: apiLostHeaders, body: apiLostBody,
    });
    const apiRetryResult = await apiRetry.json();
    assert.equal(apiRetry.status, 200, JSON.stringify(apiRetryResult));
    assert.equal(apiRetryResult.event.event_kind, 'add');
    assert.equal(apiRetryResult.event.item_id, apiRetryResult.result.item.item_id);
    assert.equal(apiRetryResult.result.item.item_title, apiLostTitle);
    assert.equal(relay.uploads.length, beforeLostApi + 1, 'local API retry returns its original emitted event without posting again');
  } finally { await localApi.close(); }

  const beforeDropped = relay.uploads.length;
  relay.dropNextReply({ offline: true });
  const lostAdd = await cliResult(clones[0], envs[0], 'add', 'web', 'Lost clone reply');
  assert.equal(lostAdd.status, 1);
  assert.equal(lostAdd.document.error.code, 'RELAY_UNAVAILABLE');
  relay.failReads(false);
  await Promise.all(clones.map((root, index) => cli(root, envs[index], 'status')));
  const retriedAdd = await cli(clones[0], envs[0], 'add', 'web', 'Lost clone reply');
  assert.equal(relay.uploads.length, beforeDropped + 1, 'three-clone recovery never posts a second operation');
  const retriedId = retriedAdd.item.item_id;
  for (const file of replicaFiles) {
    assert.equal(localEvents(file).filter((event) => event.event_kind === 'add' && event.item_id === retriedId).length, 1,
      'each replica applies the recovered add once');
  }
  assert.deepEqual(localEvents(replicaFiles[0]), localEvents(replicaFiles[1]));
  assert.deepEqual(localEvents(replicaFiles[1]), localEvents(replicaFiles[2]));

  await cli(worktrees[0], envs[0], 'claim', '1');
  const beforeDenied = relay.uploads.length;
  relay.dropNextReply({ offline: true });
  const lostDenial = await cliResult(worktrees[1], envs[1], 'claim', '1');
  assert.equal(lostDenial.status, 1);
  assert.equal(lostDenial.document.error.code, 'RELAY_UNAVAILABLE');
  relay.failReads(false);
  await cli(clones[1], envs[1], 'status');
  const pendingState = JSON.parse(readFileSync(join(commonDir(clones[1], envs[1]), 'pullboard', 'relay.json'), 'utf8'));
  const recordedDenial = receipts(replicaFiles[1]).find((receipt) => JSON.parse(receipt.move).id === pendingState.recovered.move.id);
  assert.equal(recordedDenial.outcome.error.code, 'HELD');
  const retriedDenial = await cliResult(worktrees[1], envs[1], 'claim', '1');
  assert.equal(retriedDenial.status, 1);
  assert.deepEqual(retriedDenial.document.error, recordedDenial.outcome.error, 'retry reports the original canonical refusal');
  assert.equal(relay.uploads.length, beforeDenied + 1, 'a refused move also keeps its original relay position');
  await cli(worktrees[0], envs[0], 'release', '1');
  await cli(worktrees[0], envs[0], 'claim', '2');
  relay.dropNextReply({ offline: true });
  const lostSubmit = await cliResult(worktrees[0], envs[0], 'submit', '2');
  assert.equal(lostSubmit.status, 1);
  assert.equal(lostSubmit.document.error.code, 'RELAY_UNAVAILABLE');
  relay.failReads(false);
  await cli(clones[0], envs[0], 'status');
  const beforeSubmitRetry = relay.uploads.length;
  const originalCommit = gitAt(worktrees[0], envs[0], 'rev-parse', 'HEAD');
  writeFileSync(join(worktrees[0], 'web', 'README.md'), 'new committed work while the original submission reply is missing\n');
  gitAt(worktrees[0], envs[0], 'add', 'web/README.md');
  gitAt(worktrees[0], envs[0], 'commit', '-q', '-m', 'test: move HEAD during submission recovery [G1]');
  assert.notEqual(gitAt(worktrees[0], envs[0], 'rev-parse', 'HEAD'), originalCommit);
  writeFileSync(join(worktrees[0], 'web', 'README.md'), 'dirty current work is not a fresh submission\n');
  const retriedSubmit = await cli(worktrees[0], envs[0], 'submit', '2');
  assert.equal(retriedSubmit.commit, originalCommit);
  assert.equal(retriedSubmit.gate.green, true);
  assert.match(retriedSubmit.gate.report, /recovered the original submission/,
    'changed or dirty HEAD only receives the original receipt, never a fresh gate claim');
  assert.equal(relay.uploads.length, beforeSubmitRetry, 'submitted-state preconditions cannot duplicate or strand recovery');
  assert.equal(gitAt(worktrees[0], envs[0], 'rev-parse', retriedSubmit.pin), originalCommit);
  gitAt(worktrees[0], envs[0], 'restore', 'web/README.md');

  relay.dropNextReply({ offline: true });
  const lostVerify = await cliResult(worktrees[1], envs[1], 'verify', '2', 'accept', '--note', 'Lost verdict acknowledgement');
  assert.equal(lostVerify.status, 1);
  assert.equal(lostVerify.document.error.code, 'RELAY_UNAVAILABLE');
  relay.failReads(false);
  await cli(clones[1], envs[1], 'status');
  const beforeVerifyRetry = relay.uploads.length;
  const retriedVerify = await cli(worktrees[1], envs[1], 'verify', '2', 'accept', '--note', 'Lost verdict acknowledgement');
  assert.equal(retriedVerify.decision, 'ACCEPT');
  assert.equal(relay.uploads.length, beforeVerifyRetry, 'verified-state preconditions also preserve the original outcome');

  const lostEditBrief = join(clones[0], 'lost-edit-brief.md');
  writeFileSync(lostEditBrief, 'Files: web/README.md\nTest: the original edit is recovered once.\n');
  const beforeEdit = relay.uploads.length;
  relay.dropNextReply({ offline: true });
  const lostEdit = await cliResult(clones[0], envs[0], 'edit', '1', '--brief-file', lostEditBrief);
  assert.equal(lostEdit.document.error.code, 'RELAY_UNAVAILABLE');
  relay.failReads(false);
  await cli(clones[0], envs[0], 'status');
  rmSync(lostEditBrief);
  const editRetry = await cli(clones[0], envs[0], 'edit', '1', '--brief-file', lostEditBrief);
  assert.equal(editRetry.item.item_brief, 'Files: web/README.md\nTest: the original edit is recovered once.');
  assert.equal(relay.uploads.length, beforeEdit + 1, 'edit retries recover the original receipt after its brief disappears');

  const lostRef = 'lost-merge-reference';
  gitAt(clones[0], envs[0], 'tag', lostRef, originalCommit);
  const beforeMerge = relay.uploads.length;
  relay.dropNextReply({ offline: true });
  const lostMerge = await cliResult(clones[0], envs[0], 'merged', '2', lostRef);
  assert.equal(lostMerge.document.error.code, 'RELAY_UNAVAILABLE');
  relay.failReads(false);
  await cli(clones[0], envs[0], 'status');
  gitAt(clones[0], envs[0], 'tag', '-d', lostRef);
  const mergeRetry = await cli(clones[0], envs[0], 'merged', '2', lostRef);
  assert.equal(mergeRetry.commit, originalCommit);
  assert.equal(relay.uploads.length, beforeMerge + 1, 'merge retries report the original full commit after its ref disappears');

  const beforeAutomatic = relay.uploads.length;
  relay.dropNextReply();
  const automatic = await cli(clones[2], envs[2], 'add', 'web', 'Automatically recovered reply');
  assert.equal(automatic.item.item_title, 'Automatically recovered reply');
  assert.equal(relay.uploads.length, beforeAutomatic + 1, 'automatic recovery keeps one ordered move');
  assert.equal(JSON.parse(readFileSync(join(commonDir(clones[2], envs[2]), 'pullboard', 'relay.json'), 'utf8')).recovered,
    undefined, 'automatic success consumes its recovered outcome');

  await Promise.all(worktrees.map((root, index) => cli(root, envs[index], 'status')));
  const updated = store.openBoard(replicaFiles[0]);
  let future;
  try {
    next = appliedSequence(updated) + 1;
    future = { ...prepareEngineMove(updated, 'addItem', [{ by: 'coordinator', lane: 'web', title: 'Future engine item' }]), engine: ENGINE_VERSION + 1 };
  } finally { store.closeBoard(updated); }
  const futureSealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(future)), {
    boardId, kind: 'move', sequence: next,
  })).toString('base64url');
  assert.equal((await fetch(`${relay.origin}/api/v1/boards/${boardId}/moves`, {
    method: 'POST', headers, body: JSON.stringify({ sequence: next, sealed: futureSealed }),
  })).status, 200);
  const beforeFuture = replicaFiles.map(localEvents);
  const incompatible = await Promise.all(clones.map((root, index) => cliResult(root, envs[index], 'add', 'web', 'Must not apply')));
  for (const result of incompatible) {
    assert.equal(result.status, 1);
    assert.equal(result.document.error.code, 'ENGINE_VERSION');
    assert.match(result.document.error.message, new RegExp(`engine version ${ENGINE_VERSION + 1}.*engine version ${ENGINE_VERSION}`));
    assert.match(result.document.error.next, /upgrade/);
  }
  assert.deepEqual(replicaFiles.map(localEvents), beforeFuture, 'neither clone applies a future engine or its own later move');

});

/** Exercise migration of an old local-first mirror queue into the ordered native checkpoint. */
async function legacyMirrorQueueFragment({
  relay, root, relayEnv, boardFile, linkFile, lane, lanes, boardId, key, currentPersonToken,
  localEvents, cli, store, unseal,
}) {
  const priorRows = localEvents(boardFile);
  const link = JSON.parse(readFileSync(linkFile, 'utf8'));
  assert.equal(link.mode, 'ordered');
  link.cursor = priorRows.at(-1)?.event_id ?? 0;
  // Model the pre-161 local-first outbox: old link metadata plus local rows committed before upload.
  delete link.mode;
  delete link.presentationDigest;
  writeFileSync(linkFile, JSON.stringify(link) + '\n', { mode: 0o600 });

  const board = store.openBoard(boardFile);
  try {
    store.addItem(board, {
      by: 'coordinator', lane, title: 'legacy queued item', criterion: 'queued before ordered mode',
    });
    store.shout(board, {
      from: 'coordinator', to: 'person', text: 'legacy queued shout', lanes,
    });
  } finally { store.closeBoard(board); }

  const queuedRows = localEvents(boardFile);
  const queuedEvents = queuedRows.slice(priorRows.length);
  assert.deepEqual(queuedEvents.map((event) => event.event_kind), ['add', 'shout']);
  const initialUploadCount = relay.uploads.length;
  const expectedBehind = queuedEvents.length;

  relay.failMoves(true);
  const offline = await cli(root, relayEnv, 'status');
  assert.equal(offline.relay.behind, expectedBehind, 'the legacy local rows remain in the durable queue');
  assert.deepEqual(localEvents(boardFile), queuedRows, 'a failed migration leaves local rows untouched');
  assert.equal(relay.uploads.length, initialUploadCount, 'refused uploads are not acknowledged');
  const pendingLegacy = JSON.parse(readFileSync(linkFile, 'utf8'));
  assert.equal(pendingLegacy.pending.sequence, link.sequence + 1);
  assert.equal(pendingLegacy.pending.needsPresentation, true, 'the first legacy row has no projection covering its position');

  relay.failMoves(false);
  const resumed = await cli(root, relayEnv, 'status');
  assert.equal(resumed.relay.behind, 0, 'the next reachable command drains the queued legacy rows');
  assert.deepEqual(localEvents(boardFile), queuedRows, 'migration checkpoints existing rows instead of replaying them');
  const legacyUploads = relay.uploads.slice(initialUploadCount);
  assert.deepEqual(legacyUploads.map((upload) => upload.sequence), [4, 5]);
  const openedLegacy = await Promise.all(legacyUploads.map(async (upload) => JSON.parse(new TextDecoder().decode(await unseal(
    key, Buffer.from(upload.sealed, 'base64url'), { boardId, kind: 'move', sequence: upload.sequence },
  )))));
  assert.equal(openedLegacy[0].presentation, undefined, 'the historical first move cannot attest the later row');
  assert.equal(openedLegacy[1].presentation.state.events[0].event_id, queuedEvents.at(-1).event_id, 'the final legacy move carries only its matching projection');

  const authorization = { 'x-pullboard-engine': '3', authorization: `Bearer ${currentPersonToken}` };
  const stateResponse = await fetch(`${relay.origin}/api/v1/boards/${boardId}/state`, { headers: authorization });
  assert.equal(stateResponse.status, 200);
  const stateDocument = await stateResponse.json();
  assert.equal(stateDocument.state.sequence, 5, 'the native checkpoint covers the complete ordered prefix');
  const checkpoint = JSON.parse(new TextDecoder().decode(await unseal(
    key, Buffer.from(stateDocument.state.sealed, 'base64url'), { boardId, kind: 'snapshot', sequence: 5 },
  )));
  assert.deepEqual(checkpoint.tables.event.slice(priorRows.length), queuedEvents,
    'the source-native snapshot records both legacy rows in order');
  assert.ok(checkpoint.presentation.state.items.some((item) => item.title === 'legacy queued item'));

  const repeated = await cli(root, relayEnv, 'status');
  assert.equal(repeated.relay.behind, 0);
  assert.deepEqual(localEvents(boardFile), queuedRows, 'a repeated sync does not execute legacy rows again');
  assert.equal(relay.uploads.length, initialUploadCount + 2, 'a repeated sync does not append duplicate uploads');
  const unchangedResponse = await fetch(`${relay.origin}/api/v1/boards/${boardId}/state`, { headers: authorization });
  assert.equal((await unchangedResponse.json()).state.sealed, stateDocument.state.sealed,
    'a repeated sync leaves the acknowledged native checkpoint unchanged');
}

/** Confirm migration refuses an unrecognized remote prefix before executing another local move. */
async function legacyForeignPrefixFragment({
  relay, root, relayEnv, boardFile, linkFile, lane, boardId, currentPersonToken, localEvents, cliResult,
}) {
  const originalLink = readFileSync(linkFile, 'utf8');
  const link = JSON.parse(originalLink);
  assert.equal(link.mode, 'ordered');
  link.cursor = localEvents(boardFile).at(-1)?.event_id ?? 0;
  delete link.mode;
  delete link.presentationDigest;
  writeFileSync(linkFile, JSON.stringify(link) + '\n', { mode: 0o600 });

  const foreign = await fetch(`${relay.origin}/api/v1/boards/${boardId}/moves`, {
    method: 'POST',
    headers: { 'x-pullboard-engine': '3', authorization: `Bearer ${currentPersonToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: link.sequence + 1, sealed: 'AQ' }),
  });
  assert.equal(foreign.status, 200, await foreign.text());

  const beforeAttempt = localEvents(boardFile);
  const refused = await cliResult(root, relayEnv, 'add', lane, 'must not follow a foreign prefix');
  assert.equal(refused.status, 1);
  assert.equal(refused.document.error.code, 'RELAY_DIVERGED');
  assert.match(refused.document.error.message, new RegExp(`relay sequence ${link.sequence + 1}.*local sequence ${link.sequence}`));
  assert.match(refused.document.error.next, /relay off.*relay on.*pairing/);
  assert.deepEqual(localEvents(boardFile), beforeAttempt, 'a foreign prefix is refused before the CLI move applies');

  writeFileSync(linkFile, originalLink, { mode: 0o600 });
}
