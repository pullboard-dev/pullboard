/** Sealed relay recovery keeps a collision's retry while the winner catches an appended tail [H16]. */
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';
import { fixture } from '../../../tests/fixtures/relay/sealed.js';
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../tests/fixtures/child.js';
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { store } from '../../../tests/fixtures/relay/sealed-client.js';
import { openBoard } from '../../../tests/fixtures/relay/sealed-client.js';
import { exportBoard } from '../../../tests/fixtures/relay/sealed-client.js';
import { appliedSequence } from '../../../tests/fixtures/relay/sealed-client.js';
import { sealMove } from '../../../tests/fixtures/relay/sealed-client.js';
import { ENGINE_VERSION } from '../../../tests/fixtures/relay/sealed-client.js';
import { relayRecover } from '../../../tests/fixtures/relay/sealed-client.js';
import { syncRelay } from '../../../tests/fixtures/relay/sealed-client.js';
import { main } from '../../../tests/fixtures/native.js';
import { openCheckpoint } from '../../../tests/fixtures/relay/sealed-client.js';
import { replayClient } from '../../../tests/fixtures/relay/sealed-client.js';
import { initializeReplica } from '../../../tests/fixtures/relay/sealed-client.js';
import { blockedRecoveryFixture } from '../../../tests/fixtures/relay/sealed-client.js';

after(cleanupFixtureChildren);

test('recovery collision status preserves the retry while the winner catches an appended tail [H16]', async (t) => {
  // The injected faults address the released whole-ciphertext API1 checkpoint contract.
  const box = await fixture(t, { legacySnapshots: true });
  await blockedRecoveryFixture(box);
  const secondRoot = join(box.directory, 'recovery-collision-replica');
  const secondHome = join(box.directory, 'recovery-collision-home');
  mkdirSync(secondRoot);
  mkdirSync(secondHome, { mode: 0o700 });
  const secondEnv = { ...box.env, HOME: secondHome, PULLBOARD_HOME: secondHome };
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: secondRoot, env: secondEnv }).status, 0);
  await initializeReplica(secondRoot, secondEnv);
  const snapshotFile = join(box.directory, 'collision-initial.json');
  writeFileSync(snapshotFile, JSON.stringify(box.document), { mode: 0o600 });
  await replayClient(secondRoot, secondEnv, 'import', snapshotFile);
  mkdirSync(join(secondHome, 'relay-keys'), { mode: 0o700 });
  writeFileSync(join(secondHome, 'relay-keys', box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
  writeFileSync(join(secondRoot, '.git/pullboard/relay.json'), JSON.stringify({ version: 1, mode: 'ordered', board: box.id,
    url: box.origin, repository: 'fixture/repository', token: box.machines[0].token, sequence: 0, cursor: box.document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });

  const previousHome = process.env.PULLBOARD_HOME;
  const previousFetch = globalThis.fetch;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'PUT' && String(url).endsWith('/state')) {
      return new Response(JSON.stringify({ version: 1, error: { code: 'CHECKPOINT_TEST', message: 'private collision fixture' } }),
        { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return previousFetch(url, options);
  };
  process.env.PULLBOARD_HOME = box.home;
  await assert.rejects(() => relayRecover(box.root, 1, { ...apiBoardOpeners, err: () => {}, say: () => {} }), { code: 'CHECKPOINT_TEST' });
  process.env.PULLBOARD_HOME = secondHome;
  await assert.rejects(() => relayRecover(secondRoot, 1, { ...apiBoardOpeners, err: () => {}, say: () => {} }), { code: 'CHECKPOINT_TEST' });
  const firstLink = JSON.parse(readFileSync(join(box.root, '.git/pullboard/relay.json'), 'utf8'));
  const secondLink = JSON.parse(readFileSync(join(secondRoot, '.git/pullboard/relay.json'), 'utf8'));
  assert.notEqual(firstLink.recovery.sealed, secondLink.recovery.sealed, 'each replica stages its own exact encrypted checkpoint');

  globalThis.fetch = previousFetch;
  process.env.PULLBOARD_HOME = box.home;
  await relayRecover(box.root, 1, { ...apiBoardOpeners, err: () => {}, say: () => {} });
  const winningCheckpoint = (await box.call(box.path + '/state')).body.state;
  const winningNative = await openCheckpoint(box, winningCheckpoint);
  process.env.PULLBOARD_HOME = secondHome;
  const futureNative = structuredClone(winningNative);
  futureNative.tables.board_meta.find((row) => row.meta_key === 'relay_engine_version').meta_value = String(ENGINE_VERSION + 1);
  const futureSeal = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(futureNative)),
    { boardId: box.id, kind: 'snapshot', sequence: 1 })).toString('base64url');
  assert.equal((await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 1, sealed: futureSeal } })).status, 200);
  await assert.rejects(() => relayRecover(secondRoot, 1, { ...apiBoardOpeners, err: () => {}, say: () => {} }), { code: 'ENGINE_VERSION' },
    'an authenticated winning snapshot still stops at its newer engine version');
  const noProofNative = structuredClone(winningNative);
  noProofNative.tables.board_meta = noProofNative.tables.board_meta.filter((row) => row.meta_key !== 'relay_refusal_1');
  const noProofSeal = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(noProofNative)),
    { boardId: box.id, kind: 'snapshot', sequence: 1 })).toString('base64url');
  assert.equal((await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 1, sealed: noProofSeal } })).status, 200);
  await assert.rejects(() => relayRecover(secondRoot, 1, { ...apiBoardOpeners, err: () => {}, say: () => {} }), { code: 'RELAY_RECOVERY_PENDING' },
    'a person checkpoint without the selected refusal proof cannot resolve the pending recovery');
  assert.equal((await box.call(box.path + '/state', { method: 'PUT', token: box.person.token,
    body: { sequence: winningCheckpoint.sequence, sealed: winningCheckpoint.sealed } })).status, 200);
  globalThis.fetch = async (url, options = {}) => {
    const response = await previousFetch(url, options);
    if (options.method !== 'GET' || !String(url).endsWith('/state')) return response;
    const document = await response.json();
    document.state.sender = { kind: 'agent', agent: 'client-two', userId: 'fixture-user' };
    return new Response(JSON.stringify(document), { status: response.status, headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(() => relayRecover(secondRoot, 1, { ...apiBoardOpeners, err: () => {}, say: () => {} }), { code: 'RELAY_PERSON_ONLY' },
    'the checkpoint sender must be a person even when its ciphertext matches a saved recovery');
  globalThis.fetch = previousFetch;
  const markers = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL'];
  const previousMarkers = Object.fromEntries(markers.map((marker) => [marker, process.env[marker]]));
  t.after(() => markers.forEach((marker) => {
    if (previousMarkers[marker] === undefined) delete process.env[marker];
    else process.env[marker] = previousMarkers[marker];
  }));
  for (const marker of markers) delete process.env[marker];
  let adoptedOutput = '';
  const streams = { cwd: secondRoot, stdout: { isTTY: false, write: (text) => { adoptedOutput += text; } }, stderr: { isTTY: false, write: () => {} } };
  assert.equal(await main(['relay', 'recover', '--skip', '1'], streams), 0);
  assert.equal(adoptedOutput.includes('relay recovery adopted the authenticated checkpoint at sequence 1; blocked sequence 1 remains recorded as refused'), true,
    'the CLI reports adoption rather than claiming it published the winner');
  const syncDiagnostics = [];
  const syncSummary = await syncRelay(secondRoot, { ...apiBoardOpeners, err: (line) => syncDiagnostics.push(line), say: () => {} });
  assert.deepEqual(syncSummary.recovery, { pending: false, skip: 0, next: '' }, 'adoption clears the durable recovery');
  assert.equal(syncDiagnostics.length, 0);
  const collisionStatus = await replayClient(secondRoot, secondEnv, 'status');
  assert.equal(collisionStatus.relay.behind, 0);
  assert.deepEqual(collisionStatus.relay.recovery, { pending: false, skip: 0, next: '' }, 'actual status reports the adopted checkpoint as complete');
  const humanStatus = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), 'status'],
    { cwd: secondRoot, env: secondEnv, encoding: 'utf8' });
  assert.equal(humanStatus.status, 0);
  assert.equal(humanStatus.stdout.includes('recovery pending for sequence 1; retry pullboard relay recover --skip 1'), false);
  const humanRelay = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), 'relay'],
    { cwd: secondRoot, env: secondEnv, encoding: 'utf8' });
  assert.equal(humanRelay.status, 0);
  assert.equal(humanRelay.stdout.includes('recovery pending for sequence 1; retry pullboard relay recover --skip 1'), false);
  const stillBlocked = openBoard(join(secondRoot, '.git/pullboard/board.sqlite'));
  try { assert.equal(appliedSequence(stillBlocked), 1, 'the losing client adopts the authenticated winning checkpoint'); }
  finally { store.closeBoard(stillBlocked); }

  const lane = Object.keys(JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8')).lanes)[0];
  const tail = { version: 1, engine: 3, id: 'recovery-tail-after-collision', operation: 'shout',
    args: [{ from: 'person', to: 'coordinator', request: true, text: 'Tail after recovery checkpoint', lanes: [lane] }] };
  const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(tail)),
    { boardId: box.id, kind: 'request', sequence: 2 })).toString('base64url');
  assert.equal((await box.call(box.path + '/requests', { method: 'POST', token: box.person.token, body: { sequence: 2, sealed } })).status, 200);
  process.env.PULLBOARD_HOME = box.home;
  await replayClient(box.root, box.env, 'relay');
  process.env.PULLBOARD_HOME = secondHome;
  await replayClient(secondRoot, secondEnv, 'relay');
  const winner = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  const other = openBoard(join(secondRoot, '.git/pullboard/board.sqlite'));
  try {
    assert.equal(appliedSequence(winner), 2, 'the winner catches the appended tail after recovery');
    assert.equal(appliedSequence(other), 2, 'the adopted client also catches the appended person move');
    assert.deepEqual(exportBoard(other).tables, exportBoard(winner).tables, 'both actual clients converge on the same native rows');
  }
  finally { store.closeBoard(other); store.closeBoard(winner); }
});
