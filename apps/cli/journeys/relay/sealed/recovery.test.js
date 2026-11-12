/** Sealed relay recovery skips future-engine blockers and keeps retries on two real clients [H3,H16]. */
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';
import { main as nativeTestMain } from '../../../tests/fixtures/native.js';
import { fixture } from '../../../tests/fixtures/relay/sealed.js';
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../tests/fixtures/child.js';
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { after } from 'node:test';
import { test } from 'node:test';
import { serveView } from '../../../src/io/commands/view.js';
import { registerProject } from '../../../../../packages/seats/index.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { main } from '../../../tests/fixtures/native.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { semanticBoardDigest } from '../../../../../packages/store/index.js';
import { appliedSequence } from '../../../../../packages/state/index.js';
import { checkpointSequence } from '../../../../../packages/state/index.js';
import { requireSupportedEngine } from '../../../../../packages/state/index.js';
import { seal as sealMove } from '../../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { relayRecover } from '../../../../../packages/link/index.js';
import { syncRelay } from '../../../../../packages/link/index.js';
import { openCheckpoint } from '../../../tests/fixtures/relay/sealed-client.js';
import { replayClient } from '../../../tests/fixtures/relay/sealed-client.js';
import { initializeReplica } from '../../../tests/fixtures/relay/sealed-client.js';

after(cleanupFixtureChildren);

test('person recovery explicitly skips one future-engine blocker and publishes a refusal checkpoint [H3,H16]', async (t) => {
  // The injected faults address the released whole-ciphertext API1 checkpoint contract.
  const box = await fixture(t, { legacySnapshots: true });
  for (const args of [['help', 'relay', 'recover'], ['relay', 'recover', '--help'], ['help', '--all']]) {
    const help = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), ...args],
      { cwd: box.root, env: box.env, encoding: 'utf8' });
    assert.equal(help.status, 0, `recovery help succeeds: ${args.join(' ')}`);
    assert.match(help.stdout, /relay recover --skip <sequence>/u, 'public help retains the recovery retry command');
  }
  const seededBoard = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    store.shout(seededBoard, { from: 'person', to: 'coordinator', text: 'read cursor recovery probe', lanes: ['web'], request: true });
    box.document = exportBoard(seededBoard);
  } finally { store.closeBoard(seededBoard); }
  const keyDirectory = join(box.home, 'relay-keys');
  mkdirSync(keyDirectory, { mode: 0o700 });
  writeFileSync(join(keyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
  writeFileSync(join(box.root, '.git/pullboard/relay.json'), JSON.stringify({ version: 1, mode: 'ordered', board: box.id,
    url: box.origin, repository: 'fixture/repository', token: box.machines[0].token, sequence: 0, cursor: box.document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
  assert.equal((await box.call(box.path + '/state', { method: 'PUT', token: box.person.token,
    body: { sequence: 0, sealed: Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(box.document)), { boardId: box.id, kind: 'snapshot', sequence: 0 })).toString('base64url') } })).status, 200);
  const future = { version: 1, engine: ENGINE_VERSION + 1, id: 'future-engine-record', operation: 'unknownFromFuture', args: [] };
  assert.throws(() => requireSupportedEngine(future), { code: 'ENGINE_VERSION' });
  assert.equal((await box.call(box.path + '/moves', { method: 'POST', token: box.one.token,
    body: { sequence: 1, sealed: Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(future)), { boardId: box.id, kind: 'move', sequence: 1 })).toString('base64url') } })).status, 200);
  assert.equal((await box.call(box.path + '/events?after=0')).body.events.length, 1);
  const diagnostics = [];
  const io = { ...apiBoardOpeners, err: (message) => diagnostics.push(message), say: () => {} };
  const previousPullboardHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.home;
  t.after(() => { if (previousPullboardHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = previousPullboardHome; });
  const secondRoot = join(box.directory, 'recovery-replica');
  const secondHome = join(box.directory, 'recovery-replica-home');
  mkdirSync(secondRoot); mkdirSync(secondHome, { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: secondRoot, env: box.env }).status, 0);
  await initializeReplica(secondRoot, { ...box.env, HOME: secondHome, PULLBOARD_HOME: secondHome });
  const initialFile = join(box.directory, 'recovery-initial.json');
  writeFileSync(initialFile, JSON.stringify(box.document), { mode: 0o600 });
  await replayClient(secondRoot, { ...box.env, HOME: secondHome, PULLBOARD_HOME: secondHome }, 'import', initialFile);
  const secondKeyDirectory = join(secondHome, 'relay-keys');
  mkdirSync(secondKeyDirectory, { mode: 0o700 });
  writeFileSync(join(secondKeyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
  writeFileSync(join(secondRoot, '.git/pullboard/relay.json'), JSON.stringify({ version: 1, mode: 'ordered', board: box.id,
    url: box.origin, repository: 'fixture/repository', token: box.machines[0].token, sequence: 0, cursor: box.document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
  const blocked = await box.call(box.path + '/events?after=0');
  assert.equal(blocked.body.events.length, 1);
  const ordinary = await syncRelay(box.root, io);
  assert.match(diagnostics.join('\n'), /ENGINE_VERSION/);
  assert.equal(ordinary.sequence, 0, 'ordinary catch-up stops without advancing either replica');
  await assert.rejects(() => relayRecover(box.root, 2, io), /blocked next sequence 1/);
  const agentAttempt = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), 'relay', 'recover', '--skip', '1', '--json'],
    { cwd: box.root, env: { ...box.env, CODEX_THREAD_ID: 'private-agent-test' }, encoding: 'utf8' });
  assert.equal(agentAttempt.status, 1);
  assert.match(agentAttempt.stdout, /B26_PERSON_CHANNEL/);
  const originalBoard = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  const originalDocument = exportBoard(originalBoard);
  store.closeBoard(originalBoard);
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'PUT' && String(url).endsWith('/state')) {
      return new Response(JSON.stringify({ version: 1, error: { code: 'CHECKPOINT_TEMPORARY', message: 'temporary fixture refusal' } }),
        { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, options);
  };
  await assert.rejects(() => relayRecover(box.root, 1, io), { code: 'CHECKPOINT_TEMPORARY' });
  const savedBeforeRetry = JSON.parse(readFileSync(join(box.root, '.git/pullboard/relay.json'), 'utf8')).recovery;
  assert.equal(savedBeforeRetry.skip, 1, 'the exact staged recovery remains durable after a known publish failure');
  assert.equal((await box.call(box.path + '/state')).body.state.sequence, 0, 'a failed publish does not replace the remote checkpoint');
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'PUT' && String(url).endsWith('/state')) {
      await realFetch(url, options);
      throw new Error('fixture dropped the checkpoint acknowledgement');
    }
    return realFetch(url, options);
  };
  await assert.rejects(() => relayRecover(box.root, 1, io), { code: 'RELAY_UNAVAILABLE' });
  globalThis.fetch = realFetch;
  const linkFile = join(box.root, '.git/pullboard/relay.json');
  const pendingRecovery = JSON.parse(readFileSync(linkFile, 'utf8')).recovery;
  assert.equal(pendingRecovery.skip, 1);
  globalThis.fetch = async (url, options = {}) => {
    const response = await realFetch(url, options);
    if (options.method !== 'GET' || !String(url).endsWith('/state')) return response;
    const document = await response.json();
    document.state.sender = { kind: 'agent', agent: 'client-one', userId: 'fixture-user' };
    return new Response(JSON.stringify(document), { status: response.status, headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(() => relayRecover(box.root, 1, io), { code: 'RELAY_PERSON_ONLY' },
    'a lost-ACK checkpoint still requires the relay-authenticated person sender');
  globalThis.fetch = realFetch;
  const pendingStatus = await replayClient(box.root, { ...box.env, PULLBOARD_HOME: box.home }, 'status');
  assert.equal(pendingStatus.relay.behind, 0, 'recovery remains separate from pending upload count');
  assert.deepEqual(pendingStatus.relay.recovery, { pending: true, skip: 1, next: 'pullboard relay recover --skip 1' }, 'actual status JSON exposes the saved recovery retry');
  const humanStatus = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), 'status'],
    { cwd: box.root, env: { ...box.env, PULLBOARD_HOME: box.home }, encoding: 'utf8' });
  assert.equal(humanStatus.status, 0);
  assert.equal(humanStatus.stdout.includes('recovery pending for sequence 1; retry pullboard relay recover --skip 1'), true,
    'human status shows the actionable recovery without counting it as an upload');
  registerProject(box.root);
  const localView = await serveView({ port: 0, runCommand: nativeTestMain, boardOpeners: apiBoardOpeners });
  try {
    const viewAddress = new URL(localView.url);
    const apiRequest = await fetch(viewAddress.origin + '/api/v1/boards/' + box.id + '/requests', {
      method: 'POST', headers: { 'x-pullboard-key': viewAddress.searchParams.get('k'), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'request while recovery is pending' }),
    });
    const apiRequestResult = await apiRequest.json();
    assert.equal(apiRequestResult.error.code, 'RELAY_RECOVERY_PENDING', 'the actual view request is guarded by the recovery lock');
    const afterApiRequest = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
    try { assert.deepEqual(exportBoard(afterApiRequest), originalDocument, 'the refused API request leaves native tables unchanged'); }
    finally { store.closeBoard(afterApiRequest); }
  } finally { await localView.close(); }
  const beforeInbox = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let cursorBeforeInbox;
  try { cursorBeforeInbox = beforeInbox.db.prepare("SELECT agent_last_shout_id FROM agent WHERE agent_id='coordinator'").get().agent_last_shout_id; }
  finally { store.closeBoard(beforeInbox); }
  const inboxCommand = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), 'inbox'],
    { cwd: box.root, env: { ...box.env, PULLBOARD_HOME: box.home }, encoding: 'utf8' });
  assert.equal(inboxCommand.status, 0, inboxCommand.stderr);
  assert.match(inboxCommand.stdout, /read cursor recovery probe/);
  assert.match(inboxCommand.stdout, /activity delivery was not recorded: .*RELAY_RECOVERY_PENDING/u,
    'the local read reports its deferred canonical delivery without claiming acknowledgement');
  const afterInbox = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let cursorAfterInbox;
  try { cursorAfterInbox = afterInbox.db.prepare("SELECT agent_last_shout_id FROM agent WHERE agent_id='coordinator'").get().agent_last_shout_id; }
  finally { store.closeBoard(afterInbox); }
  assert.ok(cursorAfterInbox > cursorBeforeInbox, 'the actual inbox read advances the durable read cursor');
  const acceptedCheckpoint = (await box.call(box.path + '/state')).body.state;
  assert.equal(acceptedCheckpoint.sequence, pendingRecovery.sequence);
  assert.equal(acceptedCheckpoint.sealed, pendingRecovery.sealed, 'a lost ACK retains the exact sealed checkpoint candidate');
  const unchanged = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try { assert.equal(semanticBoardDigest(exportBoard(unchanged)), semanticBoardDigest(originalDocument), 'known failure and lost ACK do not change semantic native state'); }
  finally { store.closeBoard(unchanged); }
  const recovered = await relayRecover(box.root, 1, io);
  assert.equal(recovered.sequence, 1);
  assert.equal(recovered.skipped, 1);
  assert.deepEqual(recovered.recovery, { pending: false, skip: 0, next: '' }, 'successful recovery clears the public pending state');
  const cursorAfterRecovery = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    assert.equal(cursorAfterRecovery.db.prepare("SELECT agent_last_shout_id FROM agent WHERE agent_id='coordinator'").get().agent_last_shout_id,
      cursorAfterInbox, 'checkpoint restore retains the greater local inbox cursor');
  } finally { store.closeBoard(cursorAfterRecovery); }
  const events = await box.call(box.path + '/events?after=0');
  assert.equal(events.status, 409, 'person recovery publishes and compacts an ordinary sealed checkpoint');
  const snapshot = (await box.call(box.path + '/state')).body.state;
  assert.equal(snapshot.sequence, 1);
  const document = await openCheckpoint(box, snapshot);
  assert.equal(document.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '1');
  assert.equal(document.tables.event.at(-1).event_kind, 'relay_refused');
  assert.equal(document.tables.event.at(-1).event_by, 'client-one');
  const blockedReason = JSON.parse(document.tables.board_meta.find(row => row.meta_key === 'relay_refusal_1').meta_value).outcome.error;
  assert.match(blockedReason.message, /person recovery logged this blocked record as refused; run pullboard relay/);
  const secondEnv = { ...box.env, HOME: secondHome, PULLBOARD_HOME: secondHome };
  await replayClient(secondRoot, secondEnv, 'relay');
  const firstBoard = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  const secondBoard = openBoard(join(secondRoot, '.git/pullboard/board.sqlite'));
  try {
    assert.equal(secondBoard.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='relay_applied_sequence'").get().meta_value, '1');
    assert.equal(secondBoard.db.prepare("SELECT agent_last_shout_id FROM agent WHERE agent_id='coordinator'").get().agent_last_shout_id,
      0, 'the other replica retains its own checkpoint cursor rather than inheriting this device’s local read');
    assert.deepEqual(store.events(secondBoard).map(row => row.event_kind), store.events(firstBoard).map(row => row.event_kind));
  } finally { store.closeBoard(secondBoard); store.closeBoard(firstBoard); }
  process.env.PULLBOARD_HOME = box.home;
  const personRequest = (id, text) => ({ version: 1, type: 'person-request', id, move: { verb: 'shout', args: { to: 'coordinator', text } } });
  const later = personRequest('later-person-request', 'Later person move');
  assert.equal((await box.call(box.path + '/requests', { method: 'POST', token: box.person.token,
    body: { sequence: 2, sealed: Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(later)), { boardId: box.id, kind: 'request', sequence: 2 })).toString('base64url') } })).status, 200);
  const invalid = { version: 1, engine: ENGINE_VERSION, id: 'known-item-forged-claim', operation: 'claim', args: [1, { agentId: 'forged-agent' }] };
  const sealFor = async (value, kind, sequence) => Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(value)), { boardId: box.id, kind, sequence })).toString('base64url');
  const append = (sequence, kind, sealed, token = box.one.token) => box.call(box.path + (kind === 'request' ? '/requests' : '/moves'), { method: 'POST', token, body: { sequence, sealed } });
  assert.equal((await append(3, 'move', await sealFor(invalid, 'move', 3))).status, 200);
  assert.equal((await append(4, 'move', Buffer.from([1]).toString('base64url'), box.two.token)).status, 200, 'the relay stores current-version ciphertext opaquely');
  const repeated = personRequest('reused-content-id', 'First request');
  assert.equal((await append(5, 'request', await sealFor(repeated, 'request', 5), box.person.token)).status, 200);
  const changed = personRequest('reused-content-id', 'Changed request');
  assert.equal((await append(6, 'request', await sealFor(changed, 'request', 6), box.person.token)).status, 200);
  const unknownCurrent = { version: 1, engine: ENGINE_VERSION, id: 'unknown-current-operation', operation: 'notAnOperation', args: [] };
  assert.equal((await append(7, 'move', await sealFor(unknownCurrent, 'move', 7), box.one.token)).status, 200);
  let suppressCheckpointWrites = true;
  const proxy = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (suppressCheckpointWrites && incoming.method === 'PUT' && incoming.url.endsWith('/state')) {
      outgoing.writeHead(503, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ version: 1, error: { code: 'CHECKPOINT_SUPPRESSED', message: 'private test keeps the event tail for both clients' } }));
      return;
    }
    const response = await fetch(box.origin + incoming.url, { method: incoming.method,
      headers: { ...(incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {}),
        'x-pullboard-engine': incoming.headers['x-pullboard-engine'] ?? '', ...(body.length ? { 'content-type': 'application/json' } : {}) },
      ...(body.length ? { body } : {}) });
    let payload = await response.text();
    if (incoming.url.includes('/events?after=')) {
      const document = JSON.parse(payload);
      const record = document.events?.find(event => event.event_id === 3);
      if (record) record.sender = { kind: 'agent', agent: 'client-one', userId: 'x'.repeat(257) };
      payload = JSON.stringify(document);
    }
    outgoing.writeHead(response.status, { 'content-type': 'application/json' });
    outgoing.end(payload);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
  for (const root of [box.root, secondRoot]) {
    const path = join(root, '.git/pullboard/relay.json');
    const link = JSON.parse(readFileSync(path, 'utf8'));
    link.url = proxyUrl;
    writeFileSync(path, JSON.stringify(link) + '\n', { mode: 0o600 });
  }
  await replayClient(box.root, { ...box.env, PULLBOARD_HOME: box.home }, 'relay');
  const one = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    assert.equal(appliedSequence(one), 11, diagnostics.join('\n'));
    const refusals = store.events(one).filter(row => row.event_kind === 'relay_refused');
    assert.deepEqual(refusals.map(row => JSON.parse(row.event_detail).code).slice(-4), ['RELAY_SENDER', 'SEAL_FORMAT', 'PERSON_REQUEST_ID', 'RELAY_SENDER_MISMATCH']);
    assert.ok(refusals.some(row => row.item_id === 1 && row.event_by === 'relay'), 'malformed sender is normalized to relay and refusal names existing item #1');
    const unsupportedOperation = JSON.parse(one.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='relay_refusal_7'").get().meta_value).outcome.error;
    assert.equal(unsupportedOperation.code, 'RELAY_SENDER_MISMATCH', 'an unknown operation is refused before a replica can interpret it');
    assert.equal(store.events(one).filter(row => row.event_kind === 'shout').length, 5, 'the two valid person requests each produce a claim and their real CLI shout');
    const requests = JSON.parse(one.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='relay_person_requests'").get().meta_value);
    assert.deepEqual(requests.map(({ id, status, error }) => ({ id, status, code: error?.code ?? null })), [
      { id: 'later-person-request', status: 'done', code: null },
      { id: 'reused-content-id', status: 'done', code: null },
      { id: 'reused-content-id-6', status: 'refused', code: 'PERSON_REQUEST_ID' },
    ], 'recovery and the native executor preserve person request identities and their outcomes');
  } finally { store.closeBoard(one); }
  await replayClient(secondRoot, { ...box.env, HOME: secondHome, PULLBOARD_HOME: secondHome }, 'relay');
  const firstAfterTail = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  const secondAfterTail = openBoard(join(secondRoot, '.git/pullboard/board.sqlite'));
  try {
    assert.equal(appliedSequence(secondAfterTail), 11);
    assert.deepEqual(store.events(secondAfterTail).map(row => row.event_detail), store.events(firstAfterTail).map(row => row.event_detail));
    assert.equal(semanticBoardDigest(exportBoard(secondAfterTail)), semanticBoardDigest(exportBoard(firstAfterTail)),
      'both replicas converge on semantic state after later person moves; their inbox cursors remain local metadata');
  } finally { store.closeBoard(secondAfterTail); store.closeBoard(firstAfterTail); }
  const logged = await replayClient(box.root, { ...box.env, PULLBOARD_HOME: box.home }, 'log', '1');
  assert.ok(logged.events.some(row => row.event_kind === 'relay_refused' && row.item_id === 1), 'pullboard log #1 exposes the refusal');
  const current = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  const healthySequence = appliedSequence(current) + 1;
  store.closeBoard(current);
  const healthyRequest = personRequest('healthy-request-after-refusals', 'Healthy request must not be skipped');
  assert.equal((await append(healthySequence, 'request', await sealFor(healthyRequest, 'request', healthySequence), box.person.token)).status, 200);
  await assert.rejects(() => relayRecover(box.root, healthySequence, io), { code: 'RELAY_RECOVERY_HEALTHY' });
  const stillAtSeven = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try { assert.equal(appliedSequence(stillAtSeven), healthySequence - 1); }
  finally { store.closeBoard(stillAtSeven); }
  await replayClient(box.root, { ...box.env, PULLBOARD_HOME: box.home }, 'relay');
  await replayClient(secondRoot, secondEnv, 'relay');
  const beforeHeader = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  const futureSequence = appliedSequence(beforeHeader) + 1;
  store.closeBoard(beforeHeader);
  const futureSealHeader = Buffer.from([2]).toString('base64url');
  // The record comes from a newer engine, as a real newer seal would: from an engine no newer, it is junk, set aside (#343).
  assert.equal((await box.call(box.path + '/moves', { method: 'POST', token: box.one.token, headers: { 'x-pullboard-engine': String(ENGINE_VERSION + 1) },
    body: { sequence: futureSequence, sealed: futureSealHeader } })).status, 200);
  const sealBlocked = await replayClient(box.root, { ...box.env, PULLBOARD_HOME: box.home }, 'relay');
  assert.ok(sealBlocked.diagnostics.some(line => line.includes('SEAL_VERSION')));
  const atEight = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try { assert.equal(appliedSequence(atEight), futureSequence - 1); }
  finally { store.closeBoard(atEight); }
  suppressCheckpointWrites = false;
  const headerRecovery = await replayClient(box.root, { ...box.env, PULLBOARD_HOME: box.home }, 'relay', 'recover', '--skip', String(futureSequence));
  assert.equal(headerRecovery.version, 1);
  assert.equal(headerRecovery.linked, true);
  assert.equal(headerRecovery.board, box.id);
  assert.equal(headerRecovery.sequence, futureSequence);
  assert.equal(headerRecovery.skipped, futureSequence);
  assert.equal(typeof headerRecovery.url, 'string');
  assert.equal(typeof headerRecovery.link, 'string');
  assert.equal(typeof headerRecovery.behind, 'number');
  await replayClient(secondRoot, secondEnv, 'relay');
  const restoredSecond = openBoard(join(secondRoot, '.git/pullboard/board.sqlite'));
  try { assert.equal(appliedSequence(restoredSecond), futureSequence, 'second CLI client restores the sealed future-header recovery checkpoint'); }
  finally { store.closeBoard(restoredSecond); }
  process.env.PULLBOARD_HOME = box.home;
  const local = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    assert.equal(appliedSequence(local), futureSequence);
    const requests = JSON.parse(local.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='relay_person_requests'").get().meta_value);
    assert.ok(requests.some(row => row.id === 'healthy-request-after-refusals' && row.status === 'done'), 'the later sealed person request was executed and receipted after recovery');
  } finally { store.closeBoard(local); }
});

test('two future-engine blockers recover one durable position at a time on two real clients [H3,H16]', async t => {
  const box = await fixture(t);
  const roots = [box.root, join(box.directory, 'second-recovery-client')];
  const homes = [box.home, join(box.directory, 'second-recovery-home')];
  const envs = homes.map(home => ({ ...box.env, HOME: home, PULLBOARD_HOME: home }));
  const source = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let document;
  try { checkpointSequence(source, 0); document = exportBoard(source); }
  finally { store.closeBoard(source); }
  mkdirSync(roots[1]); mkdirSync(homes[1], { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: roots[1], env: envs[1] }).status, 0);
  await initializeReplica(roots[1], envs[1]);
  const initial = join(box.directory, 'two-blockers-native.json');
  writeFileSync(initial, JSON.stringify(document), { mode: 0o600 });
  await replayClient(roots[1], envs[1], 'import', initial);
  for (let index = 0; index < roots.length; index += 1) {
    mkdirSync(join(homes[index], 'relay-keys'), { mode: 0o700 });
    writeFileSync(join(homes[index], 'relay-keys', box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
    writeFileSync(join(roots[index], '.git/pullboard/relay.json'), JSON.stringify({ version: 1, mode: 'ordered', board: box.id,
      url: box.origin, repository: 'fixture/repository', token: box.machines[index].token, sequence: 0,
      cursor: document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
  }
  /** Upload only sealed records through the real authenticated relay. */
  async function upload(value, kind, sequence, token) {
    const sealed = Buffer.from(await sealMove(box.key, Buffer.from(JSON.stringify(value)), { boardId: box.id, kind, sequence })).toString('base64url');
    const reply = await box.call(box.path + (kind === 'snapshot' ? '/state' : '/moves'), {
      method: kind === 'snapshot' ? 'PUT' : 'POST', token, body: { sequence, sealed },
    });
    assert.equal(reply.status, 200);
  }
  await upload(document, 'snapshot', 0, box.person.token);
  for (let sequence = 1; sequence <= 5; sequence += 1) await upload({ version: 1, engine: ENGINE_VERSION,
    id: 'prefix-' + sequence, operation: 'unknownCurrentOperation', args: [] }, 'move', sequence, box.one.token);
  for (let index = 0; index < roots.length; index += 1) await replayClient(roots[index], envs[index], 'relay');
  for (const sequence of [6, 7]) await upload({ version: 1, engine: ENGINE_VERSION + 1, id: 'future-' + sequence,
    operation: 'futureOperation', args: [] }, 'move', sequence, box.one.token);
  await upload({ version: 1, engine: ENGINE_VERSION, id: 'later-person-eight', operation: 'shout',
    args: [{ from: 'person', to: 'coordinator', text: 'Person after two blockers', lanes: ['web'] }] }, 'move', 8, box.person.token);
  const previousHome = process.env.PULLBOARD_HOME;
  t.after(() => { if (previousHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = previousHome; });
  process.env.PULLBOARD_HOME = box.home;
  const io = { ...apiBoardOpeners, say: () => {}, err: () => {} };
  assert.equal((await syncRelay(box.root, io)).sequence, 5);
  const first = await relayRecover(box.root, 6, io);
  assert.equal(first.sequence, 6, 'later engine99 record cannot roll back the selected skip');
  assert.equal((await box.call('/api/v2/boards/' + box.id + '/state')).body.state.sequence, 6, 'skip6 is durably published before skip7');
  await replayClient(roots[1], envs[1], 'relay');
  const afterFirst = await replayClient(roots[1], envs[1], 'export');
  assert.equal(afterFirst.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '6');
  assert.ok(afterFirst.tables.event.some(row => row.event_kind === 'relay_refused' && JSON.parse(row.event_detail).sequence === 6));
  assert.equal(afterFirst.tables.shout.some(row => row.shout_text === 'Person after two blockers'), false);
  const second = await relayRecover(box.root, 7, io);
  assert.equal(second.sequence, 8, 'the second explicit skip replays the later person move');
  const exports = [];
  for (let index = 0; index < roots.length; index += 1) exports.push(await replayClient(roots[index], envs[index], 'export'));
  assert.deepEqual(exports[0].tables, exports[1].tables, 'both native replicas converge without off/on');
  assert.equal(exports[0].tables.shout.filter(row => row.shout_text === 'Person after two blockers').length, 1);
  assert.deepEqual(exports[0].tables.event.filter(row => row.event_kind === 'relay_refused').map(row => JSON.parse(row.event_detail).sequence).slice(-2), [6, 7]);
});
