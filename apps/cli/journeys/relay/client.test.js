import { viewApiPorts } from '../../../view/index.js';
/** Real device-flow CLI ordering through the opaque relay [H1,H7,H15]. */
import { withApiCommandEnvironment } from '../../tests/fixtures/api.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';

import { relayRecovered } from '../../../../packages/link/index.js';
import assert from 'node:assert/strict';
import {
  runFixtureChild as spawnSync,
  cleanupFixtureChildren,
  runFixtureChildAsync,
  runFixtureGit,
  safeFixtureDiagnostic,
} from '../../tests/fixtures/child.js';
import { createServer } from 'node:http';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  dirname,
  join,
  relative,
  resolve,
} from 'node:path';
import { tmpdir } from 'node:os';
import {
  after,
  test,
} from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createAuthHandler } from '../../../relay/index.js';
import { createRelayAuth } from '../../../relay/index.js';
import { createRelayHandler } from '../../../relay/index.js';
import { createGitHubClient } from '../../../relay/index.js';
import {
  decodeBoardKey,
  encodeBoardKey,
  generateBoardKey,
  seal,
  unseal,
} from '../../../../packages/kernel/index.js';
import { githubFixture } from '../../tests/fixtures/relay.js';
import { board as store } from '../../../lib/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { serveApi } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { main } from '../../tests/fixtures/native.js';
import {
  appliedSequence,
  checkpointSequence,
  engineReceipt,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { storeBoardKey } from '../../../../packages/keys/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { presentationShout } from '../../../../packages/pages/index.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { openPagedSnapshot } from '../../../../packages/pages/index.js';
import { initialSpecApprovalBaseline } from '../../../../packages/spec/index.js';
import { captureSpecApprovalBaseline } from '../../../../packages/spec/index.js';
import { legacyForeignPrefixFragment } from '../../tests/fixtures/relay/client/case/foreign.js';
import { legacyMirrorQueueFragment } from '../../tests/fixtures/relay/client/case/legacy.js';
import {
  assertBaselineResumeEvidence,
  assertOriginalBaselineEvidence,
} from '../../tests/fixtures/relay/client/case/baseline.js';
import {
  assertOriginalOutcomeDelivery,
  assertRecoveredStackUploads,
  settledUploadCount,
  assertReplicaClaimErrorEquality,
  localEvents,
  mergeCandidateForReview,
  receipts,
  relayUploadSummary,
  syncReplica,
} from '../../tests/fixtures/relay/client/replica.js';
import {
  assertDroppedReplyConsumed,
  commitInitializedRepoFiles,
  enterLegacyAckPolicy,
} from '../../tests/fixtures/relay/client/policy.js';
import { threeReplicaPhaseCapture } from '../../tests/fixtures/relay/client/timing.js';

const SIGN_INS = new Map();
after(cleanupFixtureChildren);

/** Read native gzip snapshots while retaining checks against historical uncompressed records. */
function snapshotDocument(plain) {
  return JSON.parse(Buffer.from(plain[0] === 0x1f && plain[1] === 0x8b ? gunzipSync(plain) : plain).toString('utf8'));
}

/** Run the actual CLI asynchronously so this process can continue serving its HTTP requests. */
function cliResult(root, env, ...args) {
  let signInStarted = false;
  let observedStderr = '';
  return runFixtureChildAsync(process.execPath, [resolve(import.meta.dirname, '../../pullboard.js'), ...args, '--json'], {
    cwd: root, env,
    onStderrChunk(part, child) {
      observedStderr += part;
      if (!signInStarted && observedStderr.includes('enter TEST-ONLY') && SIGN_INS.has(root)) {
        signInStarted = true;
        Promise.resolve(SIGN_INS.get(root)()).catch(() => child.kill('SIGKILL'));
      }
    },
  }).then((result) => {
    if (result.error) throw new Error(result.failure);
    try { return { status: result.status, document: JSON.parse(result.stdout), stderr: result.stderr, failure: result.failure }; }
    catch { throw new Error(result.failure ?? result.context); }
  });
}

/** Run a successful actual CLI command and retain refusal diagnostics on failure. */
async function cli(root, env, ...args) {
  const result = await cliResult(root, env, ...args);
  const refusal = safeFixtureDiagnostic(JSON.stringify(result.document), env);
  assert.equal(result.status, 0, `${result.failure ?? `pullboard ${args.join(' ')} exited ${result.status}: ${result.stderr}`}\n${refusal}`);
  return result.document;
}

/** Run the real auth and opaque board handlers together on a private loopback port. */
async function relayServer(t, directory, auth, { legacyRelay = false } = {}) {
  let signIn;
  let api;
  let refuseMoves = false;
  let loseReply = null;
  let refuseReads = false;
  let now = Date.now();
  const calls = [];
  const uploads = [];
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, path: req.url });
    // A historical relay has no pages router. Keep that protocol an explicit fixture choice rather than
    // making a current paged board pretend its API1 whole-snapshot endpoint still has the same representation.
    if (legacyRelay && /^\/api\/v2(?:\/|$)/u.test(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"version":1,"error":{"code":"NOT_FOUND","message":"legacy relay has no pages router"}}');
      return;
    }
    if (req.method === 'POST' && /\/moves$/.test(req.url)) {
      const drop = loseReply;
      const end = res.end.bind(res);
      res.end = (chunk, ...args) => {
        const document = JSON.parse(String(chunk));
        if (document.event) uploads.push({ sequence: document.event.event_id, sealed: document.event.sealed });
        if (drop && document.event) {
          if (!drop.operation) {
            loseReply = null;
            refuseReads = drop.offline;
            res.destroy();
            return res;
          }
          // Select a targeted drop from authenticated fixture data; never expose plaintext to logs.
          void (async () => {
            const plain = await unseal(drop.key, Buffer.from(document.event.sealed, 'base64url'), {
              boardId: drop.boardId, kind: 'move', sequence: document.event.event_id,
            });
            const move = JSON.parse(new TextDecoder().decode(plain));
            const matches = move.operation === drop.operation
              && (drop.item === undefined || move.args?.[0] === drop.item);
            if (matches && loseReply === drop) {
              loseReply = null;
              refuseReads = drop.offline;
              res.destroy();
              return;
            }
            end(chunk, ...args);
          })().catch(() => {
            // Keep the drop armed so the existing consumed-drop assertion reports failure without exposing payload details.
            res.destroy();
          });
          return res;
        }
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
    const closed = new Promise((ready, reject) => {
      server.close((error) => error ? reject(error) : ready());
    });
    server.closeAllConnections();
    await closed;
  });
  let dropArmedAt = null;
  /**
   * Refuse to continue while an armed reply drop was never consumed by a move.
   * Why: the drop is global, so a step that failed before posting its move left it armed,
   * and the next step's move (an innocent retry) was destroyed instead (#512).
   */
  function requireDropConsumed(at) {
    if (!loseReply) return;
    const since = calls.slice(dropArmedAt).map(({ method, path }) => `${method} ${path.split('?')[0]}`);
    throw new Error(`relay fixture: the reply drop armed before ${at} was never consumed by a move; relay calls since arming: ${since.join(', ') || 'none'}`);
  }
  return { origin, calls, uploads, failMoves(value) { refuseMoves = value; },
    dropNextReply({ offline = false, operation, item, key, boardId } = {}) {
      requireDropConsumed('arming another drop');
      if (operation !== undefined && (typeof operation !== 'string' || !key || !boardId)) {
        throw new Error('relay fixture: an operation-targeted drop needs its private board key and id');
      }
      loseReply = { offline, ...(operation === undefined ? {} : { operation, item, key, boardId }) };
      dropArmedAt = calls.length;
    },
    dropPending() { return Boolean(loseReply); },
    failReads(value) { if (!value) requireDropConsumed('reads were restored'); refuseReads = value; },
    advance(days) { now = Date.now() + days * 86400000; } };
}

/**
 * Copy this checkout's doctrine into a fixture repo, with every check script its rows run and the
 * scripts' own relative imports, so the fixture's Rigor checks count what the repository's do [D1,H3].
 * Reading the gates from the doctrine, not naming files here, keeps the next check that lands from
 * leaving a fixture without its script, which otherwise raises the ratchet and changes the refusal.
 * A apps/cli/pullboard.js row gets the CLI's whole runtime minus the cells plan: it imports lazily and reads skills from disk [C7].
 */
function seedDoctrine(seed) {
  const repo = resolve(import.meta.dirname, '../../../..');
  const text = readFileSync(join(repo, existsSync(join(repo, 'DOCTRINE.md')) ? 'DOCTRINE.md' : 'PRACTICE.md'), 'utf8');
  writeFileSync(join(seed, 'PRACTICE.md'), text);
  const pending = [...text.matchAll(/gate: check node (\S+\.m?js)/g)].map((match) => match[1]), copied = new Set();
  if (pending.includes('apps/cli/pullboard.js')) for (const part of ['bin', 'apps', 'packages', 'src', 'relay', 'skills', 'package.json']) cpSync(join(repo, part), join(seed, part), { recursive: true, filter: (from) => !from.endsWith('cells-plan.json') });
  while (pending.length) {
    const file = pending.pop();
    if (copied.has(file)) continue;
    copied.add(file);
    const body = readFileSync(join(repo, file), 'utf8');
    mkdirSync(dirname(join(seed, file)), { recursive: true });
    writeFileSync(join(seed, file), body);
    for (const match of body.matchAll(/from ['"](\.{1,2}\/[^'"]+)['"]/g)) pending.push(relative(repo, resolve(dirname(join(repo, file)), match[1])));
  }
}

test('clause 2: [H1,H3,H7,H15,H16] relay on snapshots and orders ciphertext, refuses offline moves, and off preserves the board (legacy relay)', async (t) => {
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
  for (const name of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[name];
  for (const name of ['PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN']) delete env[name];
  const provider = await githubFixture(t);
  let signIns = 0;
  SIGN_INS.set(root, async () => {
    signIns++;
    assert.equal((await fetch(provider.origin + '/login/device')).status, 200);
  });
  t.after(() => SIGN_INS.delete(root));
  const auth = createRelayAuth({ database: join(scratch, 'auth.sqlite'), github: createGitHubClient(provider.config) });
  t.after(() => { auth.close(); });
  // This scenario also installs and migrates historical single-record checkpoints later in its body.
  // Its original full-native, privacy, ordering, retry and unlink assertions remain unchanged.
  const relay = await relayServer(t, relayDirectory, auth, { legacyRelay: true });
  t.after(() => { rmSync(scratch, { recursive: true, force: true }); });
  const flow = auth.beginWeb();
  const authorization = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location'));
  const person = await auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), flow.binding);

  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8' });
  await cli(root, env, 'init');
  writeFileSync(join(root, 'SPEC.md'), '# Spec\n\n## G · Goals\n- G1 [approved, must] A lost reply has one original outcome. | gate: review\n');
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  runFixtureGit(['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: root, env, encoding: 'utf8' });
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
  chmodSync(keysDirectory, 0o755);
  await assert.rejects(cli(root, relayEnv, 'relay', 'on', '--url', relay.origin), /RELAY_KEY_STORAGE/);
  assert.deepEqual(await auth.boardsFor(person.token), [], 'a failed device key save creates no remote link');
  assert.ok(!relay.calls.some((call) => call.path === '/auth/boards/link'));
  assert.equal(signIns, 0, 'a failed key save does not start a foreground person sign-in');
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
  assert.ok(relay.calls.some(call => call.path === '/api/v2'), 'the current client probes the legacy relay before preserving its supported API1 flow');
  const keyFile = join(pullboardHome, 'relay-keys', `${boardId}.key`);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const keyText = readFileSync(keyFile, 'utf8').trim();
  const key = decodeBoardKey(keyText);
  const fragment = new URL(on.link).hash.slice(1);
  assert.equal(new URLSearchParams(fragment).get('board'), boardId);
  assert.equal(new URLSearchParams(fragment).get('key'), keyText, 'the phone link carries this board key only after #');

  const linkFile = join(root, '.git', 'pullboard', 'relay.json');
  const machineLink = JSON.parse(readFileSync(linkFile, 'utf8'));
  assert.match(machineLink.token, /^pm_[A-Za-z0-9_-]{43}$/u, 'the board stores its scoped machine credential');
  assert.notEqual(machineLink.token, person.token, 'the short-lived person session is not stored in the board link');
  assert.equal(machineLink.account, person.user.id);
  assert.equal(typeof machineLink.machine, 'string');
  /** Fetch a public sealed document with the current board-scoped machine credential. */
  async function get(path, token = JSON.parse(readFileSync(linkFile, 'utf8')).token) {
    const response = await fetch(relay.origin + path, { headers: { 'x-pullboard-engine': String(ENGINE_VERSION), authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  }
  const remoteState = await get(`/api/v1/boards/${boardId}/state`);
  assert.equal(remoteState.status, 200);
  const openedSnapshot = snapshotDocument(await unseal(
    key, Buffer.from(remoteState.body.state.sealed, 'base64url'), { boardId, kind: 'snapshot', sequence: 0 },
  ));
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
  assert.deepEqual(firstMoves.map((row) => row.event_kind), ['add', 'milestone_placed', 'shout']);
  const nativeAfterMoves = await get(`/api/v1/boards/${boardId}/state`);
  assert.equal(nativeAfterMoves.body.state.sequence, 2, 'the checkpoint covers both acknowledged operations');
  const checkpoint = snapshotDocument(await unseal(key, Buffer.from(nativeAfterMoves.body.state.sealed, 'base64url'), { boardId, kind: 'snapshot', sequence: 2 }));
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

  const oldLink = JSON.parse(readFileSync(linkFile, 'utf8'));
  await auth.revoke(person.token, oldLink.tokenId);
  const expired = await cli(root, relayEnv, 'status');
  assert.match((expired.diagnostics ?? []).join('\n'), /sign-in expired or was revoked.*relay on/);
  const renewed = await cli(root, relayEnv, 'relay', 'on');
  assert.equal(renewed.link, on.link, 'renewing sign-in preserves the device pairing key');
  assert.equal(renewed.sequence, 2, 'renewing sign-in preserves the relay cursor');
  assert.equal((await get(`/api/v1/boards/${boardId}/state`)).body.state.sealed, nativeAfterMoves.body.state.sealed,
    'renewing sign-in does not replace the acknowledged checkpoint');
  assert.equal(signIns, 2, 'JSON mode exposes each device code for the initial successful link and explicit renewal');

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
  assertDroppedReplyConsumed(relay, 'the legacy add reply');
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
    currentMachineToken: JSON.parse(readFileSync(linkFile, 'utf8')).token, localEvents, cli, store, unseal });
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
    currentMachineToken: JSON.parse(readFileSync(linkFile, 'utf8')).token, localEvents, cliResult });
  const localBeforeOff = await cli(root, relayEnv, 'export');
  const off = await cli(root, relayEnv, 'relay', 'off');
  assert.equal(off.linked, false);
  assert.match(off.notice, /Local link removed\. The relay copy stays until you approve deleting it on your phone\./u);
  const afterOffTables = (await cli(root, env, 'export')).tables;
  const beforeOffWithoutEvents = { ...localBeforeOff.tables };
  const afterOffWithoutEvents = { ...afterOffTables };
  delete beforeOffWithoutEvents.event;
  delete afterOffWithoutEvents.event;
  const eventSequence = rows => rows.sqlite_sequence.find(row => row.name === 'event')?.seq ?? 0;
  const beforeEventSequence = eventSequence(beforeOffWithoutEvents);
  const afterEventSequence = eventSequence(afterOffWithoutEvents);
  beforeOffWithoutEvents.sqlite_sequence = beforeOffWithoutEvents.sqlite_sequence.filter(row => row.name !== 'event');
  afterOffWithoutEvents.sqlite_sequence = afterOffWithoutEvents.sqlite_sequence.filter(row => row.name !== 'event');
  assert.deepEqual(afterOffWithoutEvents, beforeOffWithoutEvents, 'unlink preserves the local board rows and counters');
  assert.equal(afterEventSequence, beforeEventSequence + 1, 'the appended exclusion fact advances only the event counter');
  assert.deepEqual(afterOffTables.event.slice(0, -1), localBeforeOff.tables.event, 'unlink appends one exclusion fact without changing earlier events');
  assert.equal(afterOffTables.event.at(-1).event_kind, 'relay_exclusion', 'the person\'s opt-out intent stays in local history');
  assert.deepEqual(await auth.boardsFor(person.token), [{ id: boardId, repository: 'fixture/repository', linkedAt }],
    'zero-tap local unlink leaves the remote board linked');
  const session = await fetch(relay.origin + '/auth/session', { headers: { 'x-pullboard-engine': String(ENGINE_VERSION), authorization: `Bearer ${person.token}` } });
  assert.equal(session.status, 200, 'unlink preserves the person session');
  const remoteAfterOff = await fetch(`${relay.origin}/api/v1/boards/${boardId}/state`, {
    headers: { 'x-pullboard-engine': String(ENGINE_VERSION), authorization: `Bearer ${person.token}` },
  });
  assert.equal(remoteAfterOff.status, 200, 'the relay copy remains until explicit person authorization');
  assert.equal(readdirSync(relayDirectory).some((name) => name.startsWith(boardId + '.journal.sqlite')), true,
    'local off leaves the remote journal and SQLite sidecars in place');
  const afterOffCalls = relay.calls.length;
  await cli(root, env, 'status');
  assert.equal(relay.calls.length, afterOffCalls, 'unlinked commands stop connecting immediately');
  assert.equal(existsSync(keyFile), false, 'successful off removes this device copy of the board key');
  const deleted = await fetch(`${relay.origin}/api/v1/boards/${boardId}`, {
    method: 'DELETE', headers: { 'x-pullboard-engine': String(ENGINE_VERSION), authorization: `Bearer ${person.token}` },
  });
  assert.equal(deleted.status, 200, 'a separate person HTTP DELETE removes the retained relay copy');
  assert.deepEqual(await auth.boardsFor(person.token), [], 'the real person deletion unlinks the remote board');
  const afterDelete = await fetch(`${relay.origin}/api/v1/boards/${boardId}/state`, {
    headers: { 'x-pullboard-engine': String(ENGINE_VERSION), authorization: `Bearer ${person.token}` },
  });
  assert.equal(afterDelete.status, 404);
  assert.equal(readdirSync(relayDirectory).some((name) => name.startsWith(boardId + '.journal.sqlite')), false,
    'person deletion removes the relay journal and SQLite sidecars');
});

/** Link one real repository to a local relay whose next move reply can be lost at the transport. */
async function lostReplyFixture(t) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-relay-cause-')));
  const root = join(scratch, 'repo');
  const home = join(scratch, 'home');
  const pullboardHome = join(home, '.pullboard');
  const privateBin = join(scratch, 'path');
  mkdirSync(root); mkdirSync(home, { mode: 0o700 }); mkdirSync(privateBin, { mode: 0o700 });
  chmodSync(home, 0o700); chmodSync(privateBin, 0o700);
  const gitBinary = process.env.PATH.split(delimiter).map((entry) => join(entry, 'git')).find(existsSync);
  assert.ok(gitBinary, 'the fixture PATH contains git');
  symlinkSync(realpathSync(gitBinary), join(privateBin, 'git'));
  symlinkSync(realpathSync(process.execPath), join(privateBin, 'node'));
  symlinkSync(realpathSync('/bin/sh'), join(privateBin, 'sh'));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: pullboardHome, PATH: privateBin,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Relay Test', GIT_AUTHOR_EMAIL: 'relay-test@example.com',
    GIT_COMMITTER_NAME: 'Relay Test', GIT_COMMITTER_EMAIL: 'relay-test@example.com',
  };
  for (const name of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[name];
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && !name.startsWith('GIT_CONFIG') && !name.startsWith('GIT_AUTHOR') && !name.startsWith('GIT_COMMITTER')) delete env[name];
  for (const name of ['PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN']) delete env[name];
  const provider = await githubFixture(t);
  SIGN_INS.set(root, async () => {
    assert.equal((await fetch(provider.origin + '/login/device')).status, 200);
  });
  t.after(() => SIGN_INS.delete(root));
  const auth = createRelayAuth({ database: join(scratch, 'auth.sqlite'), github: createGitHubClient(provider.config) });
  t.after(() => { auth.close(); });
  const relay = await relayServer(t, join(scratch, 'relay'), auth);
  t.after(() => { rmSync(scratch, { recursive: true, force: true }); });

  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8' });
  await cli(root, env, 'init');
  runFixtureGit(['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: root, env, encoding: 'utf8' });
  const lane = Object.keys(JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).lanes)[0];
  mkdirSync(join(pullboardHome, 'relay-keys'), { recursive: true, mode: 0o700 });
  await cli(root, env, 'relay', 'on', '--url', relay.origin);
  return { root, env, lane, relay, pullboardHome };
}

/** Every credential string the linked replica holds: its relay tokens and its board key files. */
function heldSecrets(root, pullboardHome) {
  const secrets = [];
  /** Collect every string under a key that names a token, a key or a secret. */
  const walk = (value, name = '') => {
    if (typeof value === 'string') { if (/token|key|secret|cookie/iu.test(name) && value.length >= 16) secrets.push(value); return; }
    if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) walk(inner, Array.isArray(value) ? name : key);
  };
  walk(JSON.parse(readFileSync(join(root, '.git', 'pullboard', 'relay.json'), 'utf8')));
  const keys = join(pullboardHome, 'relay-keys');
  for (const entry of readdirSync(keys, { recursive: true })) {
    if (!statSync(join(keys, entry)).isFile()) continue;
    const text = readFileSync(join(keys, entry), 'utf8').trim();
    secrets.push(text);
    try { walk(JSON.parse(text), 'key'); } catch { /* a raw key file is already held whole */ }
  }
  assert.ok(secrets.some((secret) => /^p[ma]_/u.test(secret)), 'the fixture holds a relay token to keep out of diagnostics');
  return secrets;
}

/** Lose a move's reply at the transport and assert the refusal names its cause and keeps its contract. */
async function loseReplyAtTransport({ root, env, lane, relay, pullboardHome }) {
  relay.dropNextReply({ offline: true });
  const lost = await cliResult(root, env, 'add', lane, 'reply lost at the transport');
  assertDroppedReplyConsumed(relay, 'the legacy transport-failure add reply');
  assert.equal(lost.status, 1, lost.stderr);
  const refusal = lost.document.error;
  assert.equal(refusal.code, 'RELAY_UNAVAILABLE', 'the refusal code is unchanged');
  assert.ok(refusal.message.endsWith('; read the local board offline, then retry this move when the relay is reachable'), 'the refusal keeps its next step');
  assert.match(refusal.next, /\S/u, 'the refusal document keeps a next step');
  assert.ok(refusal.message.includes(`the relay ${relay.origin} did not answer`), 'the refusal names the relay address');
  assert.match(refusal.message, /did not answer \((?:timed out|no connection|[A-Z][A-Z0-9_]+) after \d+ ms on POST \/api\/v1\/boards\/[0-9a-f]{32}\/moves\)/u,
    'the refusal names the underlying transport failure and the request');
  const cause = /did not answer \(([^)]+?) after \d+ ms/u.exec(refusal.message)[1];
  assert.notEqual(cause, 'no connection', `the injected socket loss is named by its error code: ${refusal.message}`);
  const secrets = heldSecrets(root, pullboardHome);
  for (const text of [JSON.stringify(lost.document), lost.stderr]) {
    assert.ok(!secrets.some((secret) => text.includes(secret)), 'the refusal never prints a held token or key');
    assert.doesNotMatch(text, /authorization|bearer|cookie|\bp[ma]_[A-Za-z0-9_-]{8,}|\?after=/iu, 'the refusal carries no credential, header or query string');
  }
  return { cause, secrets };
}

/** Find the recovery lines a command printed, in --json diagnostics or on stderr. */
function recoveryLines(result) {
  return [...(result.document.diagnostics ?? []), result.stderr].join('\n').split('\n')
    .filter((line) => line.includes('whose earlier reply was lost'));
}

/** Escape text for a literal match inside a regular expression. */
function literal(text) { return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

test('a current paged relay keeps the complete native board while a legacy reader is told to upgrade [H1,H3,H15,H16]', async t => {
  const box = await lostReplyFixture(t);
  const marker = 'PAGED_CURRENT_NATIVE_PRIVATE_ITEM';
  await cli(box.root, box.env, 'add', box.lane, marker);
  const expected = await cli(box.root, box.env, 'export');
  const link = JSON.parse(readFileSync(join(box.root, '.git/pullboard/relay.json'), 'utf8'));
  assert.equal(link.snapshotApiVersion, 2, 'the unmodified current relay advertises and receives the paged protocol');
  const key = decodeBoardKey(readFileSync(join(box.pullboardHome, 'relay-keys', link.board + '.key'), 'utf8').trim());
  const headers = { 'x-pullboard-engine': String(ENGINE_VERSION), authorization: `Bearer ${link.token}` };
  const legacy = await fetch(box.relay.origin + '/api/v1/boards/' + link.board + '/state', { headers });
  assert.equal(legacy.status, 400);
  const upgrade = await legacy.json();
  assert.equal(upgrade.error.code, 'RELAY_API_VERSION', 'a legacy reader is explicitly told to upgrade, never given a partial native snapshot');
  assert.match(upgrade.error.message, /npm i -g pullboard@latest/u, 'the legacy refusal gives the concrete upgrade command');
  const response = await fetch(box.relay.origin + '/api/v2/boards/' + link.board + '/state', { headers });
  assert.equal(response.status, 200, 'the same actual machine credential can read the current protocol');
  const document = await response.json();
  assert.equal(document.apiVersion, 2);
  const saved = document.state;
  const opened = await openPagedSnapshot(saved.root, {
    key, boardId: link.board, sequence: saved.sequence,
    /** Read exactly the authenticated pinned graph, using the real server's object membership checks. */
    async get(id, parents) {
      const reply = await fetch(box.relay.origin + '/api/v2/boards/' + link.board + '/objects/' + id
        + '?pin=' + encodeURIComponent(saved.read.id) + '&via=' + parents.join(','), { headers });
      assert.equal(reply.status, 200);
      const page = await reply.json();
      assert.equal(page.apiVersion, 2);
      assert.equal(page.page.id, id);
      return Uint8Array.from(Buffer.from(page.page.sealed, 'base64url'));
    },
  }, { maxEngine: ENGINE_VERSION });
  const native = await opened.native();
  assert.deepEqual(native.tables, expected.tables, 'paged restore retains every native row and counter, not just the first-screen summary');
  assert.ok(native.presentation.state.items.some(item => item.title === marker));
  assert.ok(box.relay.calls.some(call => call.method === 'PUT' && /\/api\/v2\/boards\/[^/]+\/uploads\/[^/]+\/objects\//u.test(call.path)),
    'the current client uploaded bounded sealed objects through the real pages API');
  // The native export is verified after decryption; the server's stored bytes must remain opaque.
  const relayDirectory = join(box.root, '..', 'relay');
  const stored = Buffer.concat(readdirSync(relayDirectory).map(name => readFileSync(join(relayDirectory, name))));
  assert.equal(stored.includes(Buffer.from(marker)), false);
});

test('[H16,C7] a relay transport failure names its cause', async (t) => {
  const fixture = await lostReplyFixture(t);
  const { root, env, lane, relay } = fixture;
  const { cause, secrets } = await loseReplyAtTransport(fixture);

  // The repeated command recovers the move and says so once, with the earlier cause.
  relay.failReads(false);
  const repeated = await cliResult(root, env, 'add', lane, 'reply lost at the transport');
  assert.equal(repeated.status, 0, repeated.stderr);
  const lines = recoveryLines(repeated);
  assert.equal(lines.length, 1, repeated.stderr);
  assert.match(lines[0], new RegExp(`^pullboard: recovered move \\d+ \\(addItem\\) whose earlier reply was lost: ${literal(cause)}$`, 'u'));
  assert.ok(!secrets.some((secret) => repeated.stderr.includes(secret) || JSON.stringify(repeated.document).includes(secret)), 'the recovery line never prints a held token or key');
  assert.equal(repeated.document.item.item_title, 'reply lost at the transport', 'the recovered command reports its original outcome');
});

test('[H16,C7] a relay transport failure names its cause when a read recovers the move', async (t) => {
  const fixture = await lostReplyFixture(t);
  const { root, env, lane, relay } = fixture;
  const { cause, secrets } = await loseReplyAtTransport(fixture);

  // A read-only command is the later command whose catch-up recovers the move: it prints the line.
  relay.failReads(false);
  const read = await cliResult(root, env, 'list', lane);
  assert.equal(read.status, 0, read.stderr);
  const lines = recoveryLines(read);
  assert.equal(lines.length, 1, read.stderr);
  assert.match(lines[0], new RegExp(`^pullboard: recovered move \\d+ \\(addItem\\) whose earlier reply was lost: ${literal(cause)}$`, 'u'));
  assert.ok(!secrets.some((secret) => read.stderr.includes(secret) || JSON.stringify(read.document).includes(secret)), 'the recovery line never prints a held token or key');

  // The line is said once: the repeated command receives the original outcome without repeating it.
  const repeated = await cliResult(root, env, 'add', lane, 'reply lost at the transport');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(recoveryLines(repeated), [], 'the recovery line is printed once');
  assert.equal(repeated.document.item.item_title, 'reply lost at the transport', 'the recovered command reports its original outcome');
  const titles = (await cli(root, env, 'list', lane)).items.map((item) => item.item_title);
  assert.equal(titles.filter((title) => title === 'reply lost at the transport').length, 1, 'the recovered move is never duplicated');
});

/** Create the same three real linked replicas for each independently budgeted scenario. */
async function threeReplicaFixture(t, timing) {
  timing.begin('cloning three replicas', 'create the isolated seed repo, three clones, and their linked worktrees');
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
  for (const tool of ['sh', 'tar']) symlinkSync(realpathSync(process.env.PATH.split(delimiter).map((entry) => join(entry, tool)).find(existsSync)), join(privateBin, tool)); // `merged` smokes via git archive | tar
  symlinkSync(resolve(import.meta.dirname, '../../pullboard.js'), join(privateBin, 'pullboard'));
  const envs = homes.map((home) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, PULLBOARD_HOME: join(home, '.pullboard'), PATH: privateBin };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    for (const key of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[key];
    for (const key of ['PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN']) delete env[key];
    Object.assign(env, {
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Relay Clone Test', GIT_AUTHOR_EMAIL: 'relay-clone@example.com',
      GIT_COMMITTER_NAME: 'Relay Clone Test', GIT_COMMITTER_EMAIL: 'relay-clone@example.com',
    });
    return env;
  });

  /** Run fixture Git with an isolated identity and report its stderr on failure. */
  function gitAt(root, env, ...args) {
    return runFixtureGit(args, { cwd: root, env, encoding: 'utf8' });
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
  seedDoctrine(seed);
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
      const seat = store.register(seedBoard, { lane: 'web', path: worktrees[index], route: 'mid', createdBy: 'coordinator' });
      // The seed stands in for seats the coordinator enrolled through the relay, so they may verify (#579).
      seedBoard.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`agent_enrolled:${seat}`, 'coordinator');
    }
    for (let id = 1; id <= 20; id += 1) {
      store.addItem(seedBoard, {
        by: 'coordinator', lane: 'web', title: `Concurrent claim ${id}`,
        criterion: 'one clone claims this item once', specIds: ['G1'],
        brief: 'Files: web/README.md\nTest: exactly one ordered claim event is recorded.', route: 'mid', check: 'true',
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

  const provider = await timing.wait('start the private GitHub fixture', () => githubFixture(t));
  const auth = createRelayAuth({ database: join(scratch, 'auth.sqlite'), github: createGitHubClient(provider.config) });
  t.after(() => auth.close());
  const relay = await timing.wait('start the three-replica relay server', () => relayServer(t, relayDirectory, auth));
  const flow = auth.beginWeb();
  const authorization = await timing.wait('complete the private OAuth authorization request', () => fetch(flow.authorizationURL, { redirect: 'manual' }));
  const callback = new URL(authorization.headers.get('location'));
  const person = await timing.wait('exchange the fixture OAuth callback', () => auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), flow.binding));
  await timing.wait('link the cloned board to the fixture person', () => auth.linkBoard(person.token, boardId, 'fixture/repository'));

  const key = await timing.wait('generate the shared test board key', () => generateBoardKey());
  const cloneCredentials = [];
  const savedPath = process.env.PATH;
  const savedHome = process.env.PULLBOARD_HOME;
  try {
    process.env.PATH = privateBin;
    for (let index = 0; index < clones.length; index += 1) {
      process.env.PULLBOARD_HOME = envs[index].PULLBOARD_HOME;
      assert.equal(storeBoardKey(boardId, key), 'file', 'the isolated PATH forces the private file fallback');
      const keyFile = join(envs[index].PULLBOARD_HOME, 'relay-keys', `${boardId}.key`);
      assert.equal(statSync(keyFile).mode & 0o777, 0o600);
      const machine = 'machine-clone-' + (index + 1);
      const machineCredential = await timing.wait(`issue the machine credential for clone ${index + 1}`, () => auth.issueMachine(person.token, { board: boardId, machine }));
      cloneCredentials.push(machineCredential);
      assert.match(machineCredential.token, /^pm_[A-Za-z0-9_-]{43}$/u);
      // Each clone's person sign-in sets up its own coordinator token, as relay on does (#579).
      const coordinator = await auth.issueCoordinator(person.token, { board: boardId });
      // The seeded web seat stands in for one this coordinator enrolled: the relay records it the same way.
      const seat = await auth.enrollSeat(coordinator.token, boardId, { target: `web-${index + 1}`, creator: 'coordinator', sequence: index + 1, digest: String(index).repeat(64) });
      const state = {
        version: 1, mode: 'ordered', board: boardId, url: relay.origin, repository: 'fixture/repository',
        agentTokens: { coordinator: { id: coordinator.id, token: coordinator.token, expires: coordinator.expires, created: coordinator.created },
          [`web-${index + 1}`]: { id: seat.id, token: seat.token, expires: seat.expires, created: seat.created } },
        token: machineCredential.token, tokenId: machineCredential.id, account: person.user.id, machine,
        keyStorage: 'file', sequence: 0,
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
  assert.equal(new Set(cloneCredentials.map(value => value.token)).size, clones.length,
    'each clone receives a distinct real board-scoped machine credential');

  const sealed = Buffer.from(await timing.wait('seal the initial board snapshot', () => seal(key, new TextEncoder().encode(JSON.stringify(snapshot)), {
    boardId, kind: 'snapshot', sequence: 0,
  }))).toString('base64url');
  const uploaded = await timing.wait('upload the initial board snapshot', () => fetch(`${relay.origin}/api/v1/boards/${boardId}/state`, {
    method: 'PUT', headers: { 'x-pullboard-engine': String(ENGINE_VERSION), authorization: `Bearer ${cloneCredentials[0].token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: 0, sealed }),
  }));
  assert.equal(uploaded.status, 200, await timing.wait('read an unexpected initial snapshot-upload response', () => uploaded.text()));

  const replicaFiles = clones.map((clone, index) => join(commonDir(clone, envs[index]), 'pullboard', 'board.sqlite'));
  return { scratch, clones, worktrees, envs, gitAt, commonDir, auth, relay, person, key, boardId, replicaFiles };
}

/** Preserve the competing CLI claims, durable refusals, registration and local API ordering checks. */
async function competingReplicaClaims(fixture, timing) {
  const { clones, worktrees, envs, gitAt, auth, relay, person, key, boardId, replicaFiles } = fixture;
  timing.begin('competing claims', 'queue competing claims locally, replay each pair in order, and release that round\'s winner');
  // Keep the sender out of the race so each pair is resolved before an agent starts its next claim.
  for (const env of envs) env.PULLBOARD_RELAY_SENDER_BACKGROUND = '0';
  const actors = new Map();
  const winners = new Map();
  const losers = new Map();
  const senderDiagnosticsByClone = clones.map(() => []);
  const userDiagnosticsByClone = clones.map(() => []);
  relay.failMoves(true);
  for (let id = 1; id <= 20; id += 1) {
    const [left, right] = await timing.wait(`run the two competing CLI claims for item #${id}`, () => Promise.all([
      cliResult(worktrees[0], envs[0], 'claim', String(id)),
      cliResult(worktrees[1], envs[1], 'claim', String(id)),
    ]));
    const attempts = [left, right];
    attempts.forEach((attempt, index) => userDiagnosticsByClone[index].push(...(attempt.document.diagnostics ?? [])));
    assert.ok(attempts.every((result) => result.status === 0), `both clones claim #${id} locally before relay ordering`);
    const claimActors = [0, 1].map((index) => {
      const claim = localEvents(replicaFiles[index]).filter((event) => event.item_id === id && event.event_kind === 'claim');
      assert.equal(claim.length, 1, `clone ${index + 1} records its local claim for #${id} once`);
      return claim[0].event_by;
    });
    assert.notEqual(claimActors[0], claimActors[1], `the competing local claims for #${id} have distinct agents`);
    actors.set(id, claimActors);

    const first = id % 2 === 1 ? 0 : 1;
    const second = 1 - first;
    relay.failMoves(false);
    const firstReplay = await timing.wait(`replay clone ${first + 1}'s claim for #${id}`, () => syncReplica(worktrees[first], envs[first]));
    senderDiagnosticsByClone[first].push(...firstReplay.diagnostics);
    const secondReplay = await timing.wait(`replay clone ${second + 1}'s claim for #${id}`, () => syncReplica(worktrees[second], envs[second]));
    senderDiagnosticsByClone[second].push(...secondReplay.diagnostics);
    const winnerCatchUp = await timing.wait(`catch clone ${first + 1} up with the refusal for #${id}`, () => syncReplica(worktrees[first], envs[first]));
    senderDiagnosticsByClone[first].push(...winnerCatchUp.diagnostics);

    const claims = receipts(replicaFiles[first]).map((receipt) => ({ receipt, move: JSON.parse(receipt.move) }))
      .filter(({ move }) => move.operation === 'claim' && move.args[0] === id);
    assert.equal(claims.length, 2, `both competing claim attempts for #${id} have durable receipts`);
    const accepted = claims.filter(({ receipt }) => !receipt.outcome.error);
    const denied = claims.filter(({ receipt }) => receipt.outcome.error);
    assert.equal(accepted.length, 1, `one claim for #${id} wins in relay order`);
    assert.equal(denied.length, 1, `the other claim for #${id} has a durable refusal`);
    const winningActor = accepted[0].move.actor;
    const losingActor = denied[0].move.actor;
    assert.ok(actors.get(id).includes(winningActor), `the ordered winner for #${id} is one of its local claimants`);
    assert.ok(actors.get(id).includes(losingActor), `the ordered refusal for #${id} belongs to one of its local claimants`);
    assert.notEqual(winningActor, losingActor, `the winning and losing local claimants for #${id} differ`);
    winners.set(id, winningActor);
    losers.set(id, losingActor);
    assert.equal(denied[0].receipt.outcome.error.code, 'HELD', `the losing claim for #${id} is refused by the engine`);
    assert.equal(denied[0].receipt.outcome.error.next, 'Run pullboard help, correct the reported problem, and retry the command.',
      'current display guidance does not rewrite the historical receipt envelope');
    for (const index of [0, 1]) {
      const applied = localEvents(replicaFiles[index]).filter((event) => event.item_id === id && event.event_kind === 'claim');
      assert.equal(applied.length, 1, `clone ${index + 1} applies only the ordered winning claim for #${id}`);
      assert.equal(applied[0].event_by, winningActor, `clone ${index + 1} retains the same winner for #${id}`);
    }

    const winner = actors.get(id).indexOf(winningActor);
    const released = await timing.wait(`release item #${id} from its replayed winner`, () => cliResult(worktrees[winner], envs[winner], 'release', String(id), '--reason', 'BLOCKED'));
    userDiagnosticsByClone[winner].push(...(released.document.diagnostics ?? []));
    assert.equal(released.status, 0, `the ordered winner releases #${id}`);
    const winnerRelease = await timing.wait(`replay clone ${winner + 1}'s release for #${id}`, () => syncReplica(worktrees[winner], envs[winner]));
    senderDiagnosticsByClone[winner].push(...winnerRelease.diagnostics);
    const loserRelease = await timing.wait(`apply the release for #${id} on the other clone`, () => syncReplica(worktrees[1 - winner], envs[1 - winner]));
    senderDiagnosticsByClone[1 - winner].push(...loserRelease.diagnostics);
    relay.failMoves(true);
  }

  relay.failMoves(false);
  const synced = [];
  for (let index = 0; index < clones.length; index += 1) {
    const read = await timing.wait(`read clone ${index + 1} after all claim rounds`, () => cliResult(worktrees[index], envs[index], 'status'));
    synced.push(read);
    userDiagnosticsByClone[index].push(...(read.document.diagnostics ?? []));
    assert.equal(synced[index].status, 0, `clone ${index + 1} reads the completed ordered history`);
  }
  const receiptRows = replicaFiles.map((file) => receipts(file));
  for (let id = 1; id <= 20; id += 1) {
    assertReplicaClaimErrorEquality(receiptRows, id);
    for (const rows of receiptRows) {
      const claims = rows.map((receipt) => ({ receipt, move: JSON.parse(receipt.move) }))
        .filter(({ move }) => move.operation === 'claim' && move.args[0] === id);
      assert.equal(claims.length, 2, `both competing claim attempts for #${id} remain in every clone`);
      const accepted = claims.filter(({ receipt }) => !receipt.outcome.error);
      const denied = claims.filter(({ receipt }) => receipt.outcome.error);
      assert.equal(accepted.length, 1, `one durable claim receipt for #${id} succeeds`);
      assert.equal(denied.length, 1, `one durable claim receipt for #${id} is refused`);
      assert.equal(accepted[0].move.actor, winners.get(id), `every clone retains the same winner for #${id}`);
      assert.equal(denied[0].move.actor, losers.get(id), `every clone retains the same loser for #${id}`);
    }
    const loserIndex = actors.get(id).indexOf(losers.get(id));
    const displayed = (synced[loserIndex].document.relay.outboxRefusals ?? [])
      .find((entry) => entry.move === `claim #${id} by ${losers.get(id)}`);
    assert.ok(displayed, `the replayed refusal for #${id} is retained for its losing agent`);
    assert.equal(displayed.code, 'HELD');
    assert.ok(displayed.earlier.some(move => move.move === `claim #${id} by ${winners.get(id)}`),
      `the local refusal for #${id} names the ordered winning claim`);
    const notice = new RegExp(`\\[RELAY_OUTBOX_REFUSED\\].*claim #${id} by ${losers.get(id)} .*\\[HELD\\].*won by sequence \\d+ claim #${id} by ${winners.get(id)}`, 'u');
    assert.equal(senderDiagnosticsByClone[loserIndex].filter(line => notice.test(line)).length, 1,
      `the replay sender records one refusal callback for #${id}`);
    assert.equal(userDiagnosticsByClone[loserIndex].filter(line => notice.test(line)).length, 1,
      `the losing agent receives one CLI refusal notice for #${id}`);
  }
  assert.equal(receiptRows[0].length, receiptRows[1].length, 'both cloned boards retain the same number of applied operation receipts');
  const repeatedNotices = await Promise.all([0, 1].map(index => timing.wait(`confirm clone ${index + 1} notices are consumed once`,
    () => cliResult(worktrees[index], envs[index], 'status'))));
  repeatedNotices.forEach((result, index) => userDiagnosticsByClone[index].push(...(result.document.diagnostics ?? [])));
  assert.ok(repeatedNotices.every((result) => result.status === 0));
  for (const repeated of repeatedNotices) {
    assert.doesNotMatch((repeated.document.diagnostics ?? []).join('\n'), /RELAY_OUTBOX_REFUSED/u, 'replay refusal notices are delivered once');
  }

  await timing.wait('record the main-checkout setup baseline before refusing registration', () =>
    cli(clones[0], envs[0], 'shout', 'all', 'Fixture setup before registration refusal'));
  await timing.wait('sync the setup baseline to every clone before refusing registration', () =>
    Promise.all(clones.map((root, index) => cli(root, envs[index], 'status'))));
  relay.failMoves(true);
  const beforeWorktreeFailure = localEvents(replicaFiles[0]);
  const beforeWorktrees = gitAt(clones[0], envs[0], 'worktree', 'list', '--porcelain');
  const failedWorktree = await timing.wait('register the new worktree while relay moves are refused', () => cliResult(clones[0], envs[0], 'worktree', 'web', '--model', 'Fixture Model'));
  assert.equal(failedWorktree.status, 1);
  assert.equal(failedWorktree.document.error.code, 'TEMPORARY');
  assert.equal(gitAt(clones[0], envs[0], 'worktree', 'list', '--porcelain'), beforeWorktrees,
    'a refused relay registration removes only its newly-created clean worktree');
  assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/web/1'], {
    cwd: clones[0], env: envs[0],
  }).status, 1, 'the unregistered new branch is removed too');
  assert.deepEqual(localEvents(replicaFiles[0]), beforeWorktreeFailure, 'registration never runs locally before sequencing');
  relay.failMoves(false);
  await timing.wait('sync clone A after the refused worktree registration', () => cli(clones[0], envs[0], 'status'));

  const beforeInit = localEvents(replicaFiles[0]);
  const modelFreeInitEnv = { ...envs[0] };
  delete modelFreeInitEnv.PULLBOARD_MODEL;
  const initializedClone = await timing.wait('initialize clone A without bypassing relay ordering', () => cli(clones[0], modelFreeInitEnv, 'init'));
  assert.equal(initializedClone.root, clones[0]);
  assert.deepEqual(localEvents(replicaFiles[0]), beforeInit, 'repeated init cannot bypass relay ordering to rewrite coordinator registration');
  commitInitializedRepoFiles(clones[0], envs[0], gitAt);

  const board = store.openBoard(replicaFiles[0]);
  let earlier;
  let next;
  try {
    next = appliedSequence(board) + 1;
    // Clone A's own coordinator sent it from another session; one main checkout coordinates at a time (E19, #347).
    earlier = { ...prepareEngineMove(board, 'addItem', [{ by: 'coordinator', lane: 'web', title: 'Earlier remote item' }]), holder: 'machine-clone-1' };
  } finally { store.closeBoard(board); }
  const earlierSealed = Buffer.from(await timing.wait('seal the earlier coordinator move', () => seal(key, new TextEncoder().encode(JSON.stringify(earlier)), {
    boardId, kind: 'move', sequence: next,
  }))).toString('base64url');
  const coordinatorCredential = await timing.wait('issue the coordinator fixture credential', () => auth.issueCoordinator(person.token, { board: boardId }));
  const headers = { 'x-pullboard-engine': String(ENGINE_VERSION), authorization: 'Bearer ' + coordinatorCredential.token, 'content-type': 'application/json' };
  assert.equal((await timing.wait('append the earlier coordinator move', () => fetch(`${relay.origin}/api/v1/boards/${boardId}/moves`, {
    method: 'POST', headers, body: JSON.stringify({ sequence: next, sealed: earlierSealed }),
  }))).status, 200);

  const restoreApiOutboxDefault = await enterLegacyAckPolicy(fixture);
  /** Run the actual local API command under this clone's isolated device credentials. */
  async function apiCommand(argv, io) {
    return withApiCommandEnvironment(envs[0], () => timing.wait(
      'execute one local CLI operation for the cloned-board HTTP API', () => main(argv, io)));
  }
  let localApi;
  try {
    localApi = await timing.wait('start the local API used to exercise relay ordering', () => serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: apiCommand, projects: () => [{ root: clones[0], name: 'Clone API' }] }));
    const address = new URL(localApi.url);
    const response = await timing.wait('send the first API move through clone A', () => fetchFresh(`${address.origin}/api/v1/boards/${boardId}/moves`, {
      method: 'POST', headers: { 'x-pullboard-key': address.searchParams.get('k'), 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'add', args: { lane: 'web', title: 'This API item' } }),
    }));
    const result = await timing.wait('read the first API move response', () => response.json());
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.event.event_kind, 'add');
    assert.equal(result.event.item_id, result.result.item.item_id, 'the API returns its own event despite catching up an earlier add');
    assert.equal(result.result.item.item_title, 'This API item');

    const apiLostTitle = 'Lost API reply';
    const apiLostBody = JSON.stringify({ verb: 'add', args: { lane: 'web', title: apiLostTitle } });
    const apiLostHeaders = { 'x-pullboard-key': address.searchParams.get('k'), 'content-type': 'application/json' };
    const beforeLostApi = relay.uploads.length;
    relay.dropNextReply({ offline: true });
    const lostApi = await timing.wait('send the API move whose reply is dropped', () => fetchFresh(`${address.origin}/api/v1/boards/${boardId}/moves`, {
      method: 'POST', headers: apiLostHeaders, body: apiLostBody,
    }));
    assertDroppedReplyConsumed(relay, 'the lost local API add reply');
    const lostApiResult = await timing.wait('read the dropped-reply API response', () => lostApi.json());
    assert.equal(lostApi.status, 409, JSON.stringify(lostApiResult));
    assert.equal(lostApiResult.error.code, 'RELAY_UNAVAILABLE');
    relay.failReads(false);
    await timing.wait('sync clone A before retrying its lost API reply', () => cli(clones[0], envs[0], 'status'));
    const apiRetry = await timing.wait('retry the API move after its dropped reply', () => fetchFresh(`${address.origin}/api/v1/boards/${boardId}/moves`, {
      method: 'POST', headers: apiLostHeaders, body: apiLostBody,
    }));
    const apiRetryResult = await timing.wait('read the recovered API move response', () => apiRetry.json());
    assert.equal(apiRetry.status, 200, JSON.stringify(apiRetryResult));
    assert.equal(apiRetryResult.event.event_kind, 'add');
    assert.equal(apiRetryResult.event.item_id, apiRetryResult.result.item.item_id);
    assert.equal(apiRetryResult.result.item.item_title, apiLostTitle);
    assert.equal(relay.uploads.length, beforeLostApi + 1, 'local API retry returns its original emitted event without posting again');
  } finally {
    try { if (localApi) await timing.wait('close the local clone API server', () => localApi.close()); }
    finally { await restoreApiOutboxDefault(); }
  }
}

/** Preserve lost CLI replies, original outcomes and the receipt-missing stack guard. */
async function recoverReplicaReplies(fixture, timing) {
  const { scratch, clones, worktrees, envs, gitAt, commonDir, relay, key, boardId, replicaFiles } = fixture;
  timing.begin('lost-reply recovery', 'exercise dropped CLI replies, replay recovery, and durable outcome ordering across all replicas');
  // Exercise loss of the add's reply, after the separate one-time legacy migration has completed.
  await timing.wait('establish the legacy approval baseline before the add fault', () => cli(clones[0], envs[0], 'shout', 'all', 'Legacy board ready for add recovery'));
  await timing.wait('sync the migrated baseline to all clones', () => Promise.all(clones.map((root, index) => cli(root, envs[index], 'status'))));
  const beforeDropped = relay.uploads.length;
  relay.dropNextReply({ offline: true });
  const lostAdd = await timing.wait('send clone A add with its reply dropped', () => cliResult(clones[0], envs[0], 'add', 'web', 'Lost clone reply'));
  assert.equal(lostAdd.status, 0, 'a lost reply does not block the local-first add');
  const lostId = lostAdd.document.item.item_id;
  assert.equal(localEvents(replicaFiles[0]).filter(event => event.item_id === lostId && event.event_kind === 'add').length, 1,
    'the add is durable locally once even though its relay reply is lost');
  relay.failReads(false);
  await timing.wait('sync all clones to recover the lost add reply', () => Promise.all(clones.map((root, index) => cli(root, envs[index], 'status'))));
  assertDroppedReplyConsumed(relay, 'the local-first add during background replay');
  const recovered = await timing.wait('read clone A after recovering its lost add reply', () => cli(clones[0], envs[0], 'status'));
  assert.equal(recovered.relay.linked, true, 'receipt recovery leaves the board linked');
  assert.equal(recovered.relay.behind, 0, 'the lost move has been acknowledged in order');
  assert.deepEqual(recovered.relay.outbox ?? [], [], 'the recovered move is no longer queued');
  assert.equal(relay.uploads.length, beforeDropped + 1, 'three-clone recovery never posts a second operation');
  assert.equal(localEvents(replicaFiles[0]).filter(event => event.event_kind === 'spec_approval_baseline').length, 1,
    'a lost bootstrap reply is consumed through its original receipt, never a second baseline');
  const retriedId = lostId;
  for (const file of replicaFiles) {
    assert.equal(localEvents(file).filter((event) => event.event_kind === 'add' && event.item_id === retriedId).length, 1,
      'each replica applies the recovered add once');
  }
  assert.deepEqual(localEvents(replicaFiles[0]), localEvents(replicaFiles[1]));
  assert.deepEqual(localEvents(replicaFiles[1]), localEvents(replicaFiles[2]));

  relay.failMoves(true);
  const beforeDenied = relay.uploads.length;
  const queuedClaims = await timing.wait('queue competing claims before ordered replay', () => Promise.all([
    cliResult(worktrees[0], envs[0], 'claim', '1'),
    cliResult(worktrees[1], envs[1], 'claim', '1'),
  ]));
  assert.ok(queuedClaims.every(result => result.status === 0), 'both claims are durably queued before either is replayed');
  const summaryPath = index => join(commonDir(clones[index], envs[index]), 'pullboard', 'relay-outbox.summary.json');
  const queuedMove = index => JSON.parse(readFileSync(summaryPath(index), 'utf8')).moves
    .find(entry => entry.operation === 'claim' && entry.item === 1);
  const queuedA = queuedMove(0);
  const queuedB = queuedMove(1);
  assert.ok(queuedA?.id && queuedB?.id && queuedA.id !== queuedB.id, 'each clone retains its own queued claim id');
  relay.failMoves(false);
  const replayA = await timing.wait('order clone A claim first', () => syncReplica(worktrees[0], envs[0]));
  assert.equal(replayA.result.behind, 0, 'clone A claim is ordered before clone B');
  const orderedWinner = receipts(replicaFiles[0]).find(receipt => JSON.parse(receipt.move).id === queuedA.id);
  assert.ok(orderedWinner && !orderedWinner.outcome.error, 'clone A has the first accepted claim receipt');
  const beforeDroppedDenial = relay.uploads.length;
  relay.dropNextReply({ offline: true });
  await timing.wait('send clone B claim with its ordered refusal reply dropped', () => syncReplica(worktrees[1], envs[1]));
  assert.equal(relay.dropPending(), false, 'the injected reply loss was consumed by clone B claim replay');
  assert.equal(relay.uploads.length, beforeDroppedDenial + 1, 'clone B posts exactly one claim move before losing its reply');
  relay.failReads(false);
  const recoveredDenial = await timing.wait('recover clone B claim receipt after its reply loss', () => cli(clones[1], envs[1], 'status'));
  assert.equal(recoveredDenial.relay.linked, true, 'receipt recovery keeps clone B linked');
  assert.equal(recoveredDenial.relay.behind, 0, 'receipt recovery catches clone B up to the ordered prefix');
  assert.deepEqual(recoveredDenial.relay.outbox ?? [], [], 'the recovered claim no longer waits in the outbox');
  const recordedDenial = receipts(replicaFiles[1]).find((receipt) => JSON.parse(receipt.move).id === queuedB.id);
  assert.ok(recordedDenial, 'the ordered refusal has one durable receipt');
  assert.equal(recordedDenial.outcome.error.code, 'HELD');
  assert.ok(orderedWinner.sequence < recordedDenial.sequence, 'the refusal receipt follows the accepted competing claim');
  const originalReceipt = JSON.stringify(recordedDenial);
  const retriedDenial = await timing.wait('retry the claim that already has a durable refusal', () => cliResult(worktrees[1], envs[1], 'claim', '1'));
  assert.equal(retriedDenial.status, 1);
  assert.deepEqual(retriedDenial.document.error, { code: recordedDenial.outcome.error.code,
    message: recordedDenial.outcome.error.message, next: 'take another item: pullboard next' },
  'retry reports the original rule and reason with current recovery guidance');
  const afterRetry = receipts(replicaFiles[1]).find((receipt) => JSON.parse(receipt.move).id === queuedB.id);
  assert.equal(JSON.stringify(afterRetry), originalReceipt, 'presenting a retry does not rewrite any canonical receipt field');
  assert.equal(relay.uploads.length, beforeDenied + 2, 'the two queued claims each post exactly once, including the refused move');
  const restoreOutboxDefault = await enterLegacyAckPolicy(fixture);
  const ackSetup = await timing.wait('confirm the ACK scenario starts with an empty outbox', () =>
    cli(worktrees[0], envs[0], 'status'));
  assert.equal(ackSetup.relay.linked, true);
  assert.deepEqual(ackSetup.relay.outbox ?? [], [], 'legacy ACK probes start with no queued setup moves');
  await timing.wait('release item 1 after its durable refusal is checked', () => cli(worktrees[0], envs[0], 'release', '1', '--reason', 'BLOCKED'));
  await timing.wait('claim item 2 before its lost submission reply', () => cli(worktrees[0], envs[0], 'claim', '2'));
  const beforeLostSubmit = await timing.wait('confirm release and claim were acknowledged before the submit fault', () =>
    cli(worktrees[0], envs[0], 'status'));
  assert.equal(beforeLostSubmit.relay.linked, true);
  assert.deepEqual(beforeLostSubmit.relay.outbox ?? [], [], 'the armed submit reply loss cannot hit a queued setup move');
  // Submit refuses an empty head (EMPTY_SUBMIT), so item 2 needs a commit before its submission can post.
  writeFileSync(join(worktrees[0], 'web', 'lost-submit.txt'), 'the work whose submission reply is lost\n');
  gitAt(worktrees[0], envs[0], 'add', 'web/lost-submit.txt');
  gitAt(worktrees[0], envs[0], 'commit', '-q', '-m', 'test: commit the work whose submit reply is lost [G1]');
  relay.dropNextReply({ offline: true, operation: 'submit', item: 2, key, boardId });
  const lostSubmit = await timing.wait('submit item 2 with its relay reply dropped', () => cliResult(worktrees[0], envs[0], 'submit', '2', '--no-next'));
  assertDroppedReplyConsumed(relay, 'the lost item-2 submission reply');
  assert.equal(lostSubmit.status, 1);
  assert.equal(lostSubmit.document.error.code, 'RELAY_UNAVAILABLE');
  const linkFile = join(commonDir(clones[0], envs[0]), 'pullboard', 'relay.json');
  const pendingSubmit = JSON.parse(readFileSync(linkFile, 'utf8')).pending?.move;
  assert.equal(pendingSubmit?.operation, 'submit', 'the dropped reply belongs to the actual submission, not a preceding proof move');
  assert.equal(pendingSubmit?.args?.[0], 2, 'the pending submission is for item 2');
  relay.failReads(false);
  await timing.wait('sync clone A after the lost submission reply', () => cli(clones[0], envs[0], 'status'));
  const recoveredSubmit = JSON.parse(readFileSync(linkFile, 'utf8')).recovered?.move;
  assert.equal(recoveredSubmit?.operation, 'submit', 'sync preserves the exact lost submit as a retryable outcome');
  assert.equal(recoveredSubmit?.args?.[0], 2, 'the recovered outcome remains tied to item 2');
  const beforeSubmitRetry = relay.uploads.length;
  const originalCommit = gitAt(worktrees[0], envs[0], 'rev-parse', 'HEAD');
  writeFileSync(join(worktrees[0], 'web', 'README.md'), 'new committed work while the original submission reply is missing\n');
  gitAt(worktrees[0], envs[0], 'add', 'web/README.md');
  gitAt(worktrees[0], envs[0], 'commit', '-q', '-m', 'test: move HEAD during submission recovery [G1]');
  assert.notEqual(gitAt(worktrees[0], envs[0], 'rev-parse', 'HEAD'), originalCommit);
  writeFileSync(join(worktrees[0], 'web', 'README.md'), 'dirty current work is not a fresh submission\n');
  const afterSubmitRecoverySetup = relay.uploads.length;
  const retriedSubmit = await timing.wait('retry the original lost submission outcome', () => cli(worktrees[0], envs[0], 'submit', '2', '--no-next'));
  const retryMoves = await Promise.all(relay.uploads.slice(afterSubmitRecoverySetup).map(async (upload) => {
    const plain = await unseal(key, Buffer.from(upload.sealed, 'base64url'), {
      boardId, kind: 'move', sequence: upload.sequence,
    });
    const move = JSON.parse(new TextDecoder().decode(plain));
    return {
      operation: move.operation,
      moveId: move.id,
      recipient: move.operation === 'recordActivityDelivery' ? move.args?.[0]?.agentId ?? null : null,
    };
  }));
  const setupMoves = relay.uploads.slice(beforeSubmitRetry, afterSubmitRecoverySetup);
  assert.equal(setupMoves.length, 0, 'committing and dirtying HEAD does not create a relay move');
  const submittedBoard = store.openBoardForRead(join(commonDir(worktrees[0], envs[0]), 'pullboard', 'board.sqlite'));
  let submittingAgent;
  try { submittingAgent = store.getItem(submittedBoard, 2).item_owner; }
  finally { store.closeBoard(submittedBoard); }
  assert.deepEqual(retryMoves.map(({ operation }) => operation), ['recordActivityDelivery'],
    'recovered reporting records only the expected activity delivery, never a second submit');
  assert.equal(retryMoves[0].recipient, submittingAgent, 'the activity delivery is recorded for the submitting agent');
  assert.equal(typeof retryMoves[0].moveId, 'string');
  assert.equal(retriedSubmit.commit, originalCommit);
  assert.equal(retriedSubmit.gate.green, true);
  assert.match(retriedSubmit.gate.report, /recovered the original submission/,
    'changed or dirty HEAD only receives the original receipt, never a fresh gate claim');
  assert.equal(relay.uploads.length, beforeSubmitRetry + 1, 'submitted-state recovery emits only its one activity receipt, not another submit');
  assert.equal(gitAt(worktrees[0], envs[0], 'rev-parse', retriedSubmit.pin), originalCommit);
  gitAt(worktrees[0], envs[0], 'restore', 'web/README.md');

  mergeCandidateForReview(worktrees[1], envs[1], worktrees[0], originalCommit, gitAt);
  relay.dropNextReply({ offline: true, operation: 'verify', item: 2, key, boardId });
  const lostVerify = await timing.wait('verify item 2 with its acknowledgement dropped', () => cliResult(worktrees[1], envs[1], 'verify', '2', 'accept', '--note', 'Lost verdict acknowledgement', '--no-next'));
  assert.equal(lostVerify.status, 1);
  assert.equal(lostVerify.document.error.code, 'RELAY_UNAVAILABLE');
  assertDroppedReplyConsumed(relay, 'the lost item-2 verification reply');
  relay.failReads(false);
  await timing.wait('sync clone B after the lost verdict acknowledgement', () => cli(clones[1], envs[1], 'status'));
  const beforeVerifyRetry = relay.uploads.length;
  const retriedVerify = await timing.wait('retry the already-accepted verdict', () => cli(worktrees[1], envs[1], 'verify', '2', 'accept', '--note', 'Lost verdict acknowledgement', '--no-next'));
  assert.equal(retriedVerify.decision, 'ACCEPT');
  assert.deepEqual((await Promise.all(relay.uploads.slice(beforeVerifyRetry).map(async (upload) => JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(upload.sealed, 'base64url'), { boardId, kind: 'move', sequence: upload.sequence }))).operation))).filter(operation => operation === 'verify'), [], 'verified-state preconditions also preserve the original outcome, never a second verify');

  const lostEditBrief = join(clones[0], 'lost-edit-brief.md');
  writeFileSync(lostEditBrief, 'Files: web/README.md\nTest: the original edit is recovered once.\n');
  const beforeEdit = relay.uploads.length;
  relay.dropNextReply({ offline: true, operation: 'editItem', item: 1, key, boardId });
  const lostEdit = await timing.wait('edit item 1 with its relay reply dropped', () => cliResult(clones[0], envs[0], 'edit', '1', '--brief-file', lostEditBrief));
  assertDroppedReplyConsumed(relay, 'the lost item-1 edit reply');
  assert.equal(lostEdit.document.error.code, 'RELAY_UNAVAILABLE');
  relay.failReads(false);
  await timing.wait('sync clone A before retrying the edit', () => cli(clones[0], envs[0], 'status'));
  rmSync(lostEditBrief);
  const editRetry = await timing.wait('retry the original edit after its brief file is removed', () => cli(clones[0], envs[0], 'edit', '1', '--brief-file', lostEditBrief));
  assert.equal(editRetry.item.item_brief, 'Files: web/README.md\nTest: the original edit is recovered once.');
  assert.deepEqual((await Promise.all(relay.uploads.slice(beforeEdit).map(async (upload) => JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(upload.sealed, 'base64url'), { boardId, kind: 'move', sequence: upload.sequence }))).operation))).filter(operation => operation === 'editItem'), ['editItem'], 'edit retries recover the original receipt after its brief disappears, never a second edit');

  const lostRef = 'lost-merge-reference';
  gitAt(clones[0], envs[0], 'merge', '--ff-only', originalCommit);
  assert.equal(gitAt(clones[0], envs[0], 'rev-parse', 'HEAD'), originalCommit,
    'the verified submission is actually on fixture main before its merge receipt is recorded');
  gitAt(clones[0], envs[0], 'tag', lostRef, originalCommit);
  const beforeMerge = relay.uploads.length;
  relay.dropNextReply({ offline: true, operation: 'merged', item: 2, key, boardId });
  const lostMerge = await timing.wait('merge the lost reference with its reply dropped', () => cliResult(clones[0], envs[0], 'merged', '2', lostRef));
  assertDroppedReplyConsumed(relay, `the lost merge reply (merged exited ${lostMerge.status}; stdout ${JSON.stringify(lostMerge.document)}; stderr ${lostMerge.stderr})`);
  assert.equal(lostMerge.document.error.code, 'RELAY_UNAVAILABLE');
  relay.failReads(false);
  await timing.wait('sync clone A before retrying the merge', () => cli(clones[0], envs[0], 'status'));
  gitAt(clones[0], envs[0], 'tag', '-d', lostRef);
  const mergeRetry = await timing.wait('retry the original merge after its tag is removed', () => cli(clones[0], envs[0], 'merged', '2', lostRef));
  assert.equal(mergeRetry.commit, originalCommit);
  assert.deepEqual((await relayUploadSummary(relay.uploads.slice(beforeMerge), key, boardId)).map(({ operation }) => operation).filter(operation => operation === 'merged'), ['merged'], 'merge retries report the original full commit after its ref disappears, never a second merge');

  // One main checkout coordinates at a time (E19, #347): clone C takes the coordinator before it adds.
  await timing.wait('pass the coordinator to clone C', () => cli(clones[2], envs[2], 'takeover'));
  const beforeAutomatic = relay.uploads.length;
  relay.dropNextReply();
  const automatic = await timing.wait('recover a dropped reply automatically on clone C', () => cli(clones[2], envs[2], 'add', 'web', 'Automatically recovered reply'));
  assertDroppedReplyConsumed(relay, 'the automatically recovered add reply');
  assert.equal(automatic.item.item_title, 'Automatically recovered reply');
  assert.deepEqual((await relayUploadSummary(relay.uploads.slice(beforeAutomatic), key, boardId)).map(({ operation }) => operation).filter(operation => operation === 'addItem'), ['addItem'], 'automatic recovery keeps one ordered add move');
  assert.equal(JSON.parse(readFileSync(join(commonDir(clones[2], envs[2]), 'pullboard', 'relay.json'), 'utf8')).recovered,
    undefined, 'automatic success consumes its recovered outcome');
  await timing.wait('pass the coordinator back to clone A', () => cli(clones[0], envs[0], 'takeover'));

  await timing.wait('sync all worktrees before recovered-stack scenarios', () => Promise.all(worktrees.map((root, index) => cli(root, envs[index], 'status'))));

  // A lost submit reply is already an outcome, even if another item becomes stacked while this
  // replica is behind. A third, receipt-missing recovered descriptor still takes the fresh guard.
  const stackBrief = join(scratch, 'recovered-stack-brief.md');
  writeFileSync(stackBrief, 'Files: web/\nTest: only an exact durable receipt bypasses the fresh stack guard.\n');
  const stackedA = (await timing.wait('add the first recovered-stack item', () => cli(clones[0], envs[0], 'add', 'web', 'Relay recovered stack A', '--route', 'mid', '--brief-file', stackBrief, '--specs', 'G1', '--criterion', 'exact durable receipt preserves recovery and missing receipts enforce stacking', '--check', 'true'))).item.item_id;
  const stackedB = (await timing.wait('add the second recovered-stack item', () => cli(clones[0], envs[0], 'add', 'web', 'Relay recovered stack B', '--route', 'mid', '--brief-file', stackBrief, '--specs', 'G1', '--criterion', 'exact durable receipt preserves recovery and missing receipts enforce stacking', '--check', 'true'))).item.item_id;
  const freshB = (await timing.wait('add the receipt-missing recovered-stack item', () => cli(clones[0], envs[0], 'add', 'web', 'Receipt-missing recovered stack', '--route', 'mid', '--brief-file', stackBrief, '--specs', 'G1', '--criterion', 'exact durable receipt preserves recovery and missing receipts enforce stacking', '--check', 'true'))).item.item_id;
  await timing.wait('claim recovered-stack item B on worktree A', () => cli(worktrees[0], envs[0], 'claim', String(stackedB)));
  await timing.wait('claim recovered-stack item A on worktree B', () => cli(worktrees[1], envs[1], 'claim', String(stackedA)));
  await timing.wait('claim receipt-missing stack item on worktree C', () => cli(worktrees[2], envs[2], 'claim', String(freshB)));

  writeFileSync(join(worktrees[1], 'web', 'recovery-a.txt'), 'the first submitted commit\n');
  gitAt(worktrees[1], envs[1], 'add', 'web/recovery-a.txt');
  gitAt(worktrees[1], envs[1], 'commit', '-q', '-m', 'test: create first recovery commit [G1]');
  const firstRecoveryCommit = gitAt(worktrees[1], envs[1], 'rev-parse', 'HEAD');
  for (const candidate of [worktrees[0], worktrees[2]]) {
    const env = candidate === worktrees[0] ? envs[0] : envs[2];
    gitAt(candidate, env, 'fetch', '-q', worktrees[1], firstRecoveryCommit);
    gitAt(candidate, env, 'merge', '--no-ff', '-m', 'test: merge first recovery candidate [G1]', firstRecoveryCommit);
  }
  for (const [candidate, env, file, body, title] of [
    [worktrees[0], envs[0], 'web/recovery-b.txt', 'the lost-ack candidate\n', 'recovered B'],
    [worktrees[2], envs[2], 'web/recovery-fresh.txt', 'the receipt-missing candidate\n', 'fresh B'],
  ]) {
    writeFileSync(join(candidate, file), body);
    gitAt(candidate, env, 'add', file);
    gitAt(candidate, env, 'commit', '-q', '-m', `test: create ${title} candidate [G1]`);
  }
  const recoveredStackCommit = gitAt(worktrees[0], envs[0], 'rev-parse', 'HEAD');
  const freshStackCommit = gitAt(worktrees[2], envs[2], 'rev-parse', 'HEAD');

  const beforeRecoveredStack = relay.uploads.length;
  relay.dropNextReply({ offline: true, operation: 'submit', item: stackedB, key, boardId });
  const lostStackSubmit = await timing.wait('submit recovered-stack item B with its reply dropped', () => cliResult(worktrees[0], envs[0], 'submit', String(stackedB)));
  const afterLostStackSubmit = relay.uploads.length;
  assertDroppedReplyConsumed(relay, 'the recovered-stack submission reply');
  assert.equal(lostStackSubmit.status, 1);
  assert.equal(lostStackSubmit.document.error.code, 'RELAY_UNAVAILABLE');
  relay.failReads(false);
  const laterA = await timing.wait('submit stack item A after B has a lost reply', () => cliResult(worktrees[1], envs[1], 'submit', String(stackedA)));
  const afterLaterA = relay.uploads.length;
  assert.equal(laterA.status, 0, laterA.stderr);
  assert.equal(laterA.document.commit, firstRecoveryCommit);
  await timing.wait('sync clone A to recover stacked submission B', () => cli(clones[0], envs[0], 'status'));
  const afterStackRecovery = relay.uploads.length;

  const recoveredLink = join(commonDir(clones[0], envs[0]), 'pullboard', 'relay.json');
  const pendingOutcome = JSON.parse(readFileSync(recoveredLink, 'utf8')).recovered;
  const beforeOutcomeRetry = relay.uploads.length;
  const stackOwnerB = await assertRecoveredStackUploads({
    uploads: relay.uploads,
    bounds: { beforeRecoveredStack, afterLostStackSubmit, afterLaterA, afterStackRecovery, beforeOutcomeRetry },
    key, boardId, replicaFiles, stackedA, stackedB, firstRecoveryCommit, recoveredStackCommit, pendingOutcome,
  });
  const originalOutcome = await timing.wait('read the durable original submission outcome for B', () => cli(worktrees[0], envs[0], 'submit', String(stackedB), '--no-next'));
  assert.equal(originalOutcome.commit, recoveredStackCommit);
  assert.match(originalOutcome.gate.report, /recovered the original submission/u);
  await assertOriginalOutcomeDelivery(relay.uploads.slice(beforeOutcomeRetry), key, boardId, stackOwnerB);
  assert.equal(relay.uploads.length, beforeOutcomeRetry + 1);

  await timing.wait('sync clone C before checking its fabricated receiptless descriptor', () => cli(clones[2], envs[2], 'status'));
  const freshLinkFile = join(commonDir(clones[2], envs[2]), 'pullboard', 'relay.json');
  const freshLink = JSON.parse(readFileSync(freshLinkFile, 'utf8'));
  const freshBoard = store.openBoard(replicaFiles[2]);
  let fabricatedReceiptlessMove;
  try {
    const freshItem = store.getItem(freshBoard, freshB);
    const args = [freshB, {
      agentId: freshItem.item_owner,
      commit: freshStackCommit,
      tree: gitAt(worktrees[2], envs[2], 'rev-parse', 'HEAD^{tree}'),
      files: ['web/recovery-a.txt', 'web/recovery-fresh.txt'],
      submissionProof: { version: 1, files: [], full: false, deferred: true,
        reason: 'synthetic recovery descriptor; no gate execution' },
      policyCommit: gitAt(clones[2], envs[2], 'rev-parse', 'main'),
    }];
    fabricatedReceiptlessMove = prepareEngineMove(freshBoard, 'submit', args);
    assert.equal(appliedSequence(freshBoard) > 0, true);
    assert.equal(engineReceipt(freshBoard, fabricatedReceiptlessMove.id), null,
      'the recovery descriptor has no durable engine receipt');
  } finally { store.closeBoard(freshBoard); }
  const freshSequence = freshLink.sequence + 1;
  const freshSealed = Buffer.from(await timing.wait('seal the receiptless recovery descriptor', () => seal(key, new TextEncoder().encode(JSON.stringify(fabricatedReceiptlessMove)), {
    boardId, kind: 'move', sequence: freshSequence,
  }))).toString('base64url');
  freshLink.recovered = {
    move: fabricatedReceiptlessMove,
    intent: JSON.stringify({ operation: 'submit', args: fabricatedReceiptlessMove.args }),
    sequence: freshSequence,
    sealed: freshSealed,
  };
  writeFileSync(freshLinkFile, JSON.stringify(freshLink) + '\n', { mode: 0o600 });
  const beforeFreshRefusal = await settledUploadCount(relay, () => cli(worktrees[2], envs[2], 'status'));
  const freshRefusal = await timing.wait('submit the receiptless descriptor and verify the fresh stack guard', () => cliResult(worktrees[2], envs[2], 'submit', String(freshB)));
  assert.equal(freshRefusal.status, 1);
  assert.equal(freshRefusal.document.error.code, 'STACKED_ON_UNVERIFIED');
  assert.match(freshRefusal.document.error.message, new RegExp(`#${stackedA}\\b`, 'u'));
  assert.ok(freshRefusal.document.error.message.includes(firstRecoveryCommit));
  assert.equal(await settledUploadCount(relay, () => cli(worktrees[2], envs[2], 'status')), beforeFreshRefusal, 'a receipt-missing recovered descriptor is refused before relay upload');
  const freshAfter = store.openBoard(replicaFiles[2]);
  try { assert.equal(store.getItem(freshAfter, freshB).item_status, 'claimed'); }
  finally { store.closeBoard(freshAfter); }
  await restoreOutboxDefault();
}

/** Reject the future engine move after all three replicas have recovered their ordered prefix. */
async function finalReplicaOrder(fixture, timing) {
  const { clones, worktrees, envs, auth, relay, person, key, boardId, replicaFiles } = fixture;
  timing.begin('final order check', 'sync the worktrees, reject the future engine move, and confirm no replica applies later events');
  // A known future relay prefix must use the ordered ACK guard, not local-first queuing.
  const restoreOutboxDefault = await enterLegacyAckPolicy(fixture);
  try {
    await timing.wait('sync all worktrees before the final engine-version check', () => Promise.all(worktrees.map((root, index) => cli(root, envs[index], 'status'))));
    const updated = store.openBoard(replicaFiles[0]);
    let future;
    let next;
    try {
      next = appliedSequence(updated) + 1;
      future = { ...prepareEngineMove(updated, 'addItem', [{ by: 'coordinator', lane: 'web', title: 'Future engine item' }]), engine: ENGINE_VERSION + 1 };
    } finally { store.closeBoard(updated); }
    const coordinatorCredential = await timing.wait('issue the coordinator fixture credential for the final order check', () => auth.issueCoordinator(person.token, { board: boardId }));
    const headers = { 'x-pullboard-engine': String(ENGINE_VERSION), authorization: 'Bearer ' + coordinatorCredential.token, 'content-type': 'application/json' };
    const futureSealed = Buffer.from(await timing.wait('seal the future-engine move', () => seal(key, new TextEncoder().encode(JSON.stringify(future)), {
      boardId, kind: 'move', sequence: next,
    }))).toString('base64url');
    assert.equal((await timing.wait('append the future-engine move to the relay', () => fetch(`${relay.origin}/api/v1/boards/${boardId}/moves`, {
      method: 'POST', headers, body: JSON.stringify({ sequence: next, sealed: futureSealed }),
    }))).status, 200);
    const beforeFuture = replicaFiles.map(localEvents);
    const incompatible = await timing.wait('ask all three replicas to reject the future engine move', () => Promise.all(clones.map((root, index) => cliResult(root, envs[index], 'add', 'web', 'Must not apply'))));
    for (const result of incompatible) {
      assert.equal(result.status, 1);
      assert.equal(result.document.error.code, 'ENGINE_VERSION');
      assert.match(result.document.error.message, new RegExp(`engine version ${ENGINE_VERSION + 1}.*engine version ${ENGINE_VERSION}`));
      assert.match(result.document.error.next, /upgrade/);
    }
    assert.deepEqual(replicaFiles.map(localEvents), beforeFuture, 'neither clone applies a future engine or its own later move');
  } finally {
    await restoreOutboxDefault();
  }
}

test('clause 1 and clause 2: [H3,H16,V1,V17] three cloned linked replicas order competing claims', { timeout: 240_000 }, async (t) => { // 20 paired rounds (60 CLI spawns), six sync/registration spawns and three local API calls took 170s under load; setup fits the remaining ceiling.
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    await competingReplicaClaims(fixture, timing);
    timing.finish(['cloning three replicas', 'competing claims']);
  });
});

test('clause 1 and clause 2: [H3,H16,V1,V17] three cloned linked replicas recover lost replies once', { timeout: 200_000 }, async (t) => { // 45 recovery/final-order CLI spawns at the captured ~4s per recovery wait, plus 20s for fixture setup; excludes the preceding 170s claims.
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    await recoverReplicaReplies(fixture, timing);
    await finalReplicaOrder(fixture, timing);
    timing.finish(['cloning three replicas', 'lost-reply recovery', 'final order check']);
  });
});


test('clause 2: an accepted legacy approval baseline keeps its exact source through resume [H16,S1]', { timeout: 60_000 }, async t => { // budget: one lost setup reply and one real resume, bounded fixture cleanup.
  const timing = threeReplicaPhaseCapture(t);
  await timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    const { clones, envs, relay, person, replicaFiles } = fixture;
    for (const env of envs) env.PULLBOARD_RELAY_SENDER_BACKGROUND = '0';
    timing.begin('baseline reply recovery', 'lose one compatibility setup reply, change the spec, and resume');
    const uploadsBeforeLocalMove = relay.uploads.length;
    relay.dropNextReply({ offline: true });
    const first = await cliResult(clones[0], envs[0], 'add', 'web', 'Work after migration');
    assert.equal(first.status, 0, 'a lost setup reply does not block the local-first add');
    const addedId = first.document.item.item_id;
    assert.equal(localEvents(replicaFiles[0]).filter(event => event.item_id === addedId && event.event_kind === 'add').length, 1,
      'the local add is recorded once before replay');
    const original = store.openBoard(replicaFiles[0]);
    let originalBaseline;
    try { originalBaseline = store.specApprovalBaseline(original); } finally { store.closeBoard(original); }
    assert.ok(originalBaseline, 'the local first move retains the accepted setup baseline');
    const originalBaselineEvent = localEvents(replicaFiles[0]).find(event => event.event_kind === 'spec_approval_baseline');
    assert.ok(originalBaselineEvent, 'the local first move records the setup baseline event once');
    assertOriginalBaselineEvidence(originalBaselineEvent, originalBaseline);
    assert.equal(relay.uploads.length, uploadsBeforeLocalMove + 1,
      'only the existing setup move reaches the relay before the local add is replayed');
    const spec = join(clones[0], 'SPEC.md');
    writeFileSync(spec, readFileSync(spec, 'utf8') + '- G99 [approved, must] A later row needs confirmation. | gate: review\n');
    const local = store.openBoard(replicaFiles[0]);
    try {
      assert.equal(store.specApprovalBaselineExists(local), true, 'the accepted setup baseline remains present while the add is queued');
      const storedBaseline = store.specApprovalBaseline(local);
      assert.deepEqual(storedBaseline, originalBaseline, 'the original baseline event and stored source remain unchanged');
      assert.equal(storedBaseline.rows.some(row => row.id === 'G99'), false, 'a later spec row is not added to the stored baseline');
      const config = { spec: 'SPEC.md' };
      assert.ok(captureSpecApprovalBaseline(clones[0], config).rows.some(row => row.id === 'G99'));
      const selected = initialSpecApprovalBaseline({ info: { root: clones[0], isMain: true } }, local, 'recordHealthFindings', { relayRecovered, specApprovalBaselineExists: store.specApprovalBaselineExists });
      assert.equal(selected, null, 'an existing accepted baseline is not replaced by the current spec');
      assert.equal(initialSpecApprovalBaseline({ info: { root: clones[0], isMain: false } }, local, 'recordHealthFindings', { relayRecovered, specApprovalBaselineExists: store.specApprovalBaselineExists }), null, 'a lane never seeds or consumes setup');
    } finally { store.closeBoard(local); }
    relay.failReads(false);
    const resumed = await cli(clones[0], envs[0], 'resume');
    assert.ok(resumed.needsYou.some(need => need.kind === 'agent-approved' && need.id === 'G99'));
    relay.failReads(false);
    const caughtUp = await cli(clones[0], envs[0], 'status');
    assert.equal(caughtUp.relay.linked, true, 'the next reachable read keeps the board linked');
    assert.equal(caughtUp.relay.behind, 0, 'the next reachable read completes ordered replay');
    assert.deepEqual(caughtUp.relay.outbox ?? [], [], 'no queued moves remain after replay');
    const outboxRenumbered = caughtUp.relay.outboxRenumbered ?? [];
    const canonicalAddedId = outboxRenumbered.find(row => row.was === addedId)?.is ?? addedId;
    const canonicalBoard = store.openBoard(replicaFiles[0]);
    let addedItem;
    try { addedItem = store.getItem(canonicalBoard, canonicalAddedId); } finally { store.closeBoard(canonicalBoard); }
    assertBaselineResumeEvidence({ events: localEvents(replicaFiles[0]), receipts: receipts(replicaFiles[0]),
      originalBaseline, originalBaselineEvent, authenticatedLogin: person.user.login, addedId, outboxRenumbered, addedItem });
    timing.finish(['cloning three replicas', 'baseline reply recovery']);
  });
});
