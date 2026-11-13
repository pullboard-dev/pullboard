// pullboard: browser
/** @pullboard-test-gui */
/** Sealed relay recovery races, checkpoint restore and engine-4 completions [H16,V2]. */
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';
import { fixture } from '../../../tests/fixtures/relay/sealed.js';
import assert from 'node:assert/strict';
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { main } from '../../../tests/fixtures/native.js';
import {
  exportBoard,
  restoreRelaySnapshot,
  semanticBoardDigest,
} from '../../../../../packages/store/index.js';
import {
  appliedSequence,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import {
  ENGINE_VERSION,
  VERIFIER_STANDING_ENGINE,
} from '../../../../../packages/state/index.js';
import {
  relayRecover,
  syncRelay,
} from '../../../../../packages/link/index.js';
import {
  createRelayPageCache,
  snapshotSourceId,
} from '../../../../../packages/pages/index.js';
import { blockedRecoveryFixture } from '../../../tests/fixtures/relay/sealed-client.js';

after(cleanupFixtureChildren);

test('recovery preserves a local write racing its first staged publish [H16]', async (t) => {
  const box = await fixture(t);
  await blockedRecoveryFixture(box);
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.home;
  t.after(() => { if (priorHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = priorHome; });
  const priorFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = priorFetch; });
  let wrote = false;
  globalThis.fetch = async (url, options = {}) => {
    const response = await priorFetch(url, options);
    if (!wrote && String(url).includes('/events?after=0')) {
      wrote = true;
      const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
      try {
        const lane = Object.keys(JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8')).lanes)[0];
        store.addItem(board, { by: 'coordinator', lane, title: 'Concurrent local write', criterion: 'Keep this row' });
      } finally { store.closeBoard(board); }
    }
    return response;
  };
  await assert.rejects(() => relayRecover(box.root, 1, { ...apiBoardOpeners, err: () => {}, say: () => {} }), { code: 'RELAY_LOCAL_CHANGED' });
  globalThis.fetch = priorFetch;
  assert.equal((await box.call(box.path + '/state')).body.state.sequence, 0, 'no checkpoint is published after a local edit races staging');
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try { assert.ok(store.listItems(board, { all: true }).some(item => item.item_title === 'Concurrent local write')); }
  finally { store.closeBoard(board); }
  const diagnostics = [];
  await syncRelay(box.root, { ...apiBoardOpeners, err: line => diagnostics.push(line), say: () => {} });
  assert.match(diagnostics.join('\n'), /ENGINE_VERSION/);
  const afterSync = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try { assert.ok(store.listItems(afterSync, { all: true }).some(item => item.item_title === 'Concurrent local write')); }
  finally { store.closeBoard(afterSync); }
});

test('lost-ACK recovery retry refuses to overwrite a concurrent local write [H16]', async (t) => {
  const box = await fixture(t);
  await blockedRecoveryFixture(box);
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.home;
  t.after(() => { if (priorHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = priorHome; });
  const priorFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = priorFetch; });
  let wrote = false;
  globalThis.fetch = async (url, options = {}) => {
    const response = await priorFetch(url, options);
    if (!wrote && options.method === 'POST' && /\/api\/v2\/boards\/[0-9a-f]{32}\/uploads\/[^/]+\/publish$/u.test(new URL(url).pathname)) {
      wrote = true;
      const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
      try {
        const lane = Object.keys(JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8')).lanes)[0];
        store.addItem(board, { by: 'coordinator', lane, title: 'Write during lost ACK', criterion: 'Keep this row' });
      } finally { store.closeBoard(board); }
      throw new Error('fixture lost the accepted checkpoint ACK');
    }
    return response;
  };
  await assert.rejects(() => relayRecover(box.root, 1, { ...apiBoardOpeners, err: () => {}, say: () => {} }), { code: 'RELAY_UNAVAILABLE' });
  globalThis.fetch = priorFetch;
  const recovery = JSON.parse(readFileSync(join(box.root, '.git/pullboard/relay.json'), 'utf8')).recovery;
  assert.equal(recovery.skip, 1);
  assert.equal(wrote, true, 'the fault follows an actual API2 publication acknowledgement');
  const remote = await box.call('/api/v2/boards/' + box.id + '/state');
  assert.equal(remote.status, 200);
  const cache = createRelayPageCache({ board: box.id, url: box.origin });
  try {
    const prepared = cache.job(snapshotSourceId(recovery.sealed));
    assert.ok(prepared, 'the original pending checkpoint has a durable encrypted graph');
    assert.equal(remote.body.state.root.id, prepared.reference.id, 'the relay retained the exact graph published before its ACK was lost');
    assert.equal(remote.body.state.sequence, recovery.skip);
  } finally { cache.close(); }
  await assert.rejects(() => relayRecover(box.root, 1, { ...apiBoardOpeners, err: () => {}, say: () => {} }),
    { code: 'RELAY_LOCAL_CHANGED', message: /cannot be retried from the changed board/ },
    'a local change is preserved and the message does not suggest export alone will unblock retry');
  const diagnostics = [];
  await syncRelay(box.root, { ...apiBoardOpeners, err: line => diagnostics.push(line), say: () => {} });
  assert.match(diagnostics.join('\n'), /RELAY_RECOVERY_PENDING/);
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    assert.ok(store.listItems(board, { all: true }).some(item => item.item_title === 'Write during lost ACK'));
    assert.equal(appliedSequence(board), 0);
  } finally { store.closeBoard(board); }
});

test('checkpoint restore checks native digest after BEGIN IMMEDIATE against a separate connection [H16]', async (t) => {
  const box = await fixture(t);
  await blockedRecoveryFixture(box);
  const database = join(box.root, '.git/pullboard/board.sqlite');
  const source = openBoard(database);
  const concurrent = openBoard(database);
  try {
    source.db.prepare("INSERT INTO board_meta (meta_key, meta_value) VALUES ('relay_applied_sequence', '0'), ('relay_engine_version', '3')").run();
    const expectedDocument = exportBoard(source);
    const expectedDigest = semanticBoardDigest(expectedDocument);
    const lane = Object.keys(JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8')).lanes)[0];
    store.addItem(concurrent, { by: 'coordinator', lane, title: 'Write before transactional guard', criterion: 'Preserve this row' });
    assert.throws(() => restoreRelaySnapshot(source, expectedDocument, 0, expectedDigest), { code: 'RELAY_LOCAL_CHANGED' });
    assert.ok(store.listItems(source, { all: true }).some(item => item.item_title === 'Write before transactional guard'));
    assert.equal(appliedSequence(source), 0);
  } finally {
    store.closeBoard(concurrent);
    store.closeBoard(source);
  }
});

test('relay stores engine-4 sealed background completions opaquely [V2,H16]', async t => {
  const box = await fixture(t, { machineCredentials: false });
  // A board with agent tokens requires an engine-27 client (#579); the sealed move keeps engine 4.
  const headers = { 'x-pullboard-engine': String(ENGINE_VERSION) };
  assert.ok(ENGINE_VERSION >= 4, 'engine-4 background completions remain supported');
  const snapshot = await box.call(box.path + '/state', {
    method: 'PUT', token: box.person.token, headers,
    body: { sequence: 0, sealed: box.clientSeal(box.document, 'snapshot', 0) },
  });
  assert.equal(snapshot.status, 200);
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
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
  assert.deepEqual(record.sender, { kind: 'agent', userId: box.person.user.id, agent: 'client-one', policy: VERIFIER_STANDING_ENGINE, login: box.person.user.login, engine: ENGINE_VERSION });
  assert.deepEqual(box.clientOpen(record.sealed, record.kind, record.event_id), move);
});
