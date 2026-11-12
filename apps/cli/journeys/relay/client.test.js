/** Real device-flow CLI ordering through the opaque relay [H1,H7,H15]. */
import assert from 'node:assert/strict';
import {
  cleanupFixtureChildren,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../packages/kernel/index.js';
import {
  chmodSync,
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
  join,
  resolve,
} from 'node:path';
import { tmpdir } from 'node:os';
import {
  after,
  test,
} from 'node:test';
import { createRelayAuth } from '../../../relay/index.js';
import { createGitHubClient } from '../../../relay/index.js';
import {
  decodeBoardKey,
  encodeBoardKey,
  unseal,
} from '../../../../packages/kernel/index.js';
import { githubFixture } from '../../tests/fixtures/relay.js';
import { board as store } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { presentationShout } from '../../../../packages/pages/index.js';
import { openPagedSnapshot } from '../../../../packages/pages/index.js';
import { legacyForeignPrefixFragment } from '../../tests/fixtures/relay/client/case/foreign.js';
import { legacyMirrorQueueFragment } from '../../tests/fixtures/relay/client/case/legacy.js';
import { localEvents } from '../../tests/fixtures/relay/client/replica.js';
import { assertDroppedReplyConsumed } from '../../tests/fixtures/relay/client/policy.js';
import {
  SIGN_INS,
  cli,
  cliResult,
  relayServer,
  snapshotDocument,
} from '../../tests/fixtures/relay/client-harness.js';

after(cleanupFixtureChildren);

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

