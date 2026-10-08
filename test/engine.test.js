/** Real-SQLite tests for the deterministic, sequence-ordered move engine [H3,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { exportBoard, importBoard, restoreRelaySnapshot } from '../src/exchange.js';
import { applyEngineMove, prepareEngineMove, appliedSequence, engineReceipt, startRelayEpoch } from '../src/engine.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { Refused } from '../src/refused.js';

const HOUR = 3_600_000;
const CLAIM_AT = '2026-10-07T18:00:00.000Z';

/** Open two independent SQLite copies of the same registered board and one available item. */
function engineCopies(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-engine-'));
  const source = store.openBoard(join(directory, 'source.sqlite'));
  store.register(source, { lane: 'coordinator', path: '/source' });
  store.register(source, { lane: 'web', path: '/source/web-1' });
  store.register(source, { lane: 'web', path: '/source/web-2' });
  const item = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Engine fixture' });
  const document = exportBoard(source);
  const copies = ['one', 'two'].map((name, index) => {
    const clock = { now: () => new Date(`2026-10-07T${index + 16}:00:00.000Z`) };
    const board = store.openBoard(join(directory, `${name}.sqlite`), clock);
    importBoard(board, document);
    return board;
  });
  t.after(() => {
    for (const board of copies) store.closeBoard(board);
    store.closeBoard(source);
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, source, copies, item };
}

/** Prepare the same allowlisted claim on a clone, including its actor and lease inputs. */
function claimMove(board, item, agentId) {
  return prepareEngineMove(board, 'claim', [item, {
    agentId, lane: 'web', leaseMs: 2 * HOUR, head: 'a'.repeat(40),
    freeze: () => ({ text: '{"rows":[]}', digest: 'f'.repeat(64) }),
  }], { id: `claim-${item}-${agentId}` });
}

/** Read the persisted relay replay cursor, treating a fresh board as sequence zero. */
function replayCursor(board) {
  const row = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'relay_applied_sequence'").get();
  return Number(row?.meta_value ?? 0);
}

/** Snapshot user-visible board rows so refusal tests can distinguish receipts from move effects. */
function boardRows(board, itemId) {
  return {
    item: store.getItem(board, itemId),
    events: store.events(board),
  };
}

test('authenticated relay senders bind every move and refusals preserve replica prefixes [H2,H9,H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const [one, two] = copies;
  const claim = claimMove(one, item, 'web-1');
  const actorlessClaim = { ...claim, id: 'actorless-person-claim' };
  delete actorlessClaim.actor;
  const mismatchedArgs = prepareEngineMove(one, 'claim', claim.args, {
    id: 'sealed-actor-mismatch', actor: 'web-2',
  });
  const personalAnswer = prepareEngineMove(one, 'answerDecision', [1, {
    asPerson: true, agentId: 'coordinator', text: 'fixture answer', lanes: ['web'],
  }], { id: 'agent-person-answer' });
  const cases = [
    { move: actorlessClaim, sender: { kind: 'person', userId: 'fixture-user' } },
    { move: claim, sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-2' } },
    { move: mismatchedArgs, sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' } },
    { move: prepareEngineMove(one, 'register', [{ lane: 'web', path: '/fixture/enroll' }], { id: 'agent-enrollment' }), sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' } },
    { move: personalAnswer, sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' } },
    { move: prepareEngineMove(one, 'shout', [{ from: 'web-2', agentId: 'web-1', to: 'all', text: 'spoof', lanes: ['web'] }], { id: 'shadowed-shout', actor: 'web-1' }), sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' } },
    { move: prepareEngineMove(one, 'addItem', [{ by: 'coordinator', agentId: 'web-1', lane: 'web', title: 'spoof' }], { id: 'shadowed-add', actor: 'web-1' }), sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' } },
  ];

  cases.forEach(({ move, sender }, index) => {
    const sequence = index + 1;
    for (const board of copies) {
      const before = boardRows(board, item);
      const outcome = applyEngineMove(board, move, { sequence, at: CLAIM_AT, sender });
      assert.equal(outcome.error?.code, 'RELAY_ACTOR', `case ${index + 1} must refuse before native writes`);
      assert.deepEqual(boardRows(board, item), before, `case ${index + 1} leaves native rows/events unchanged`);
      assert.equal(replayCursor(board), sequence, `case ${index + 1} commits the refusal prefix`);
    }
  });

  const validClaim = { ...claim, id: 'valid-claim-after-refusals' };
  const agent = { kind: 'agent', userId: 'fixture-user', agent: 'web-1' };
  const claimOne = applyEngineMove(one, validClaim, { sequence: cases.length + 1, at: CLAIM_AT, sender: agent });
  const claimTwo = applyEngineMove(two, validClaim, { sequence: cases.length + 1, at: CLAIM_AT, sender: agent });
  assert.deepEqual(claimOne, claimTwo);
  assert.equal(store.getItem(one, item).item_owner, 'web-1');

  const shout = prepareEngineMove(one, 'shout', [{ from: 'web-1', to: 'all', text: 'authenticated fixture', lanes: ['web'] }], { id: 'valid-shout-after-refusals' });
  const shoutOne = applyEngineMove(one, shout, { sequence: cases.length + 2, at: CLAIM_AT, sender: agent });
  const shoutTwo = applyEngineMove(two, shout, { sequence: cases.length + 2, at: CLAIM_AT, sender: agent });
  assert.deepEqual(shoutOne, shoutTwo);
  assert.deepEqual(boardRows(one, item), boardRows(two, item), 'valid claim and shout replay identically after refusal prefix');
  assert.equal(replayCursor(one), cases.length + 2);
  assert.equal(replayCursor(two), cases.length + 2);
});

test('the same sealed claim replays to identical rows and sequence retries are idempotent [H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const [one, two] = copies;
  const moveOne = claimMove(one, item, 'web-1');
  const moveTwo = claimMove(two, item, 'web-1');
  assert.deepEqual(moveOne, moveTwo, 'both clones serialize the same operation and actor');

  const first = applyEngineMove(one, moveOne, { sequence: 1, at: CLAIM_AT });
  const second = applyEngineMove(two, moveTwo, { sequence: 1, at: CLAIM_AT });
  assert.deepEqual(first, second);
  assert.equal(first.events.length, 1, 'the receipt names only this operation’s committed event');
  assert.equal(first.events[0].event_kind, 'claim');
  assert.equal(first.events[0].item_id, item);
  assert.deepEqual(boardRows(one, item), boardRows(two, item), 'event ids and claim/item timestamps match');
  assert.equal(store.getItem(one, item).item_owner, 'web-1');
  assert.equal(store.getItem(one, item).item_created_at, store.getItem(two, item).item_created_at);
  assert.equal(store.getItem(one, item).item_updated_at, CLAIM_AT);
  assert.equal(store.getItem(one, item).item_lease_until, '2026-10-07T20:00:00.000Z');
  assert.equal(replayCursor(one), 1);

  const eventCount = store.events(one).length;
  const repeated = applyEngineMove(one, moveOne, { sequence: 1, at: CLAIM_AT });
  assert.deepEqual(repeated, first, 'the identical committed sequence returns its recorded result');
  assert.equal(store.events(one).length, eventCount, 'a retry cannot append a duplicate event');
  assert.equal(replayCursor(one), 1);
  const laterOne = applyEngineMove(one, moveOne, { sequence: 2, at: '2026-10-07T18:01:00.000Z' });
  const laterTwo = applyEngineMove(two, moveTwo, { sequence: 2, at: '2026-10-07T18:01:00.000Z' });
  assert.deepEqual(laterOne, first, 'an identical operation at another relay position returns its first outcome');
  assert.deepEqual(laterTwo, first);
  assert.deepEqual(boardRows(one, item), boardRows(two, item));
  assert.equal(store.events(one).length, eventCount, 'a later identical id advances the prefix without another event');
  assert.equal(replayCursor(one), 2);
  assert.equal(replayCursor(two), 2);
  const beforeChangedId = exportBoard(one);
  const different = { ...moveOne, args: [item, { ...moveOne.args[1], agentId: 'web-2' }] };
  assert.throws(() => applyEngineMove(one, different, { sequence: 3, at: CLAIM_AT }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(one), beforeChangedId, 'the same id cannot name changed operation contents');
});

test('refusals are stable, newer engines name both versions, and gaps/unknown moves do not mutate [H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const [one, two] = copies;
  const first = claimMove(one, item, 'web-1');
  const replicaFirst = claimMove(two, item, 'web-1');
  applyEngineMove(one, first, { sequence: 1, at: CLAIM_AT });
  applyEngineMove(two, replicaFirst, { sequence: 1, at: CLAIM_AT });

  const refusedOne = applyEngineMove(one, claimMove(one, item, 'web-2'), { sequence: 2, at: CLAIM_AT });
  const refusedTwo = applyEngineMove(two, claimMove(two, item, 'web-2'), { sequence: 2, at: CLAIM_AT });
  assert.deepEqual(refusedOne.error, refusedTwo.error, 'the second actor sees the same refusal on both clones');
  assert.equal(refusedOne.error.code, 'HELD');
  assert.match(refusedOne.error.message, /web-1/);
  assert.match(refusedOne.error.message, /2026-10-07T20:00:00\.000Z/);
  assert.ok(refusedOne.error.next, 'the refusal includes its next step');
  assert.deepEqual(store.getItem(one, item), store.getItem(two, item));
  assert.equal(replayCursor(one), 2, 'a deterministic refusal is itself consumed in sequence');

  const beforeNewer = boardRows(one, item);
  const beforeNewerCursor = replayCursor(one);
  const newer = { ...claimMove(one, item, 'web-2'), engine: ENGINE_VERSION + 1 };
  assert.throws(() => applyEngineMove(one, newer, { sequence: 3, at: CLAIM_AT }), (error) => {
    assert.equal(error.code, 'ENGINE_VERSION');
    assert.match(error.message, new RegExp(`engine version ${ENGINE_VERSION + 1}.*engine version ${ENGINE_VERSION}`));
    assert.match(error.message, /upgrade pullboard/);
    return true;
  });
  assert.deepEqual(boardRows(one, item), beforeNewer);
  assert.equal(replayCursor(one), beforeNewerCursor, 'a future engine is refused before cursor advance');

  const unknown = { ...claimMove(one, item, 'web-2'), operation: 'drop-database' };
  assert.throws(() => applyEngineMove(one, unknown, { sequence: 3, at: CLAIM_AT }), { code: 'RELAY_MOVE' });
  assert.deepEqual(boardRows(one, item), beforeNewer);
  assert.equal(replayCursor(one), beforeNewerCursor);

  const gap = { ...claimMove(one, item, 'web-2'), id: 'gap-probe' };
  assert.throws(() => applyEngineMove(one, gap, { sequence: 4, at: CLAIM_AT }), { code: 'RELAY_ORDER' });
  assert.deepEqual(boardRows(one, item), beforeNewer);
  assert.equal(replayCursor(one), beforeNewerCursor);
});

test('an unexpected storage failure rolls back the partial transition and its cursor [H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const board = copies[0];
  const before = boardRows(board, item);
  board.db.exec(`CREATE TRIGGER engine_test_abort_event BEFORE INSERT ON event
    WHEN NEW.event_kind = 'claim' BEGIN SELECT RAISE(ABORT, 'engine rollback probe'); END`);

  assert.throws(() => applyEngineMove(board, claimMove(board, item, 'web-1'), { sequence: 1, at: CLAIM_AT }), /engine rollback probe/);
  assert.deepEqual(boardRows(board, item), before, 'the item update and attempted event append roll back together');
  assert.equal(replayCursor(board), 0, 'unexpected storage damage cannot be consumed as an engine refusal');
});

test('nested atomic moves roll back refused writes while their outer receipt can commit [H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const board = copies[0];
  const original = store.getItem(board, item).item_title;
  store.atomic(board, () => {
    assert.throws(() => store.atomic(board, () => {
      board.db.prepare('UPDATE item SET item_title=? WHERE item_id=?').run('partial failed write', item);
      throw new Refused('TEST_REFUSAL', 'restore the original value');
    }), { code: 'TEST_REFUSAL' });
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run('test_receipt', 'refused');
  });
  assert.equal(store.getItem(board, item).item_title, original);
  assert.equal(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('test_receipt').meta_value, 'refused');
});

const CHECKPOINT_AT = '2026-10-07T18:30:00.000Z';
const RECEIPT_ID = 'checkpoint-claim';

/** Open a source board with one applied move and an occupied, divergent same-board replica. */
function snapshotFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-snapshot-'));
  const source = store.openBoard(join(directory, 'source.sqlite'), { now: () => new Date(CHECKPOINT_AT) });
  store.register(source, { lane: 'coordinator', path: '/source' });
  store.register(source, { lane: 'web', path: '/source/web-1' });
  const item = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Acknowledged item' });
  const base = exportBoard(source);
  const replica = store.openBoard(join(directory, 'replica.sqlite'), { now: () => new Date(CHECKPOINT_AT) });
  importBoard(replica, base);
  store.addItem(replica, { by: 'coordinator', lane: 'web', title: 'Divergent local item' });

  const move = prepareEngineMove(source, 'claim', [item, {
    agentId: 'web-1',
    lane: 'web',
    leaseMs: 2 * HOUR,
    head: 'a'.repeat(40),
    freeze: () => ({ text: 'frozen checkpoint criterion', digest: 'b'.repeat(64) }),
  }], { id: RECEIPT_ID });
  const applied = applyMoveForSnapshot(source, move);
  assert.ok(applied.result, 'the checkpoint includes a successfully applied move');
  const document = exportBoard(source);
  t.after(() => {
    store.closeBoard(replica);
    store.closeBoard(source);
    rmSync(directory, { recursive: true, force: true });
  });
  return { source, replica, item, document };
}

/** Apply the fixture move at the fixed checkpoint sequence and event time. */
function applyMoveForSnapshot(board, move) {
  return applyEngineMove(board, move, { sequence: 1, at: CHECKPOINT_AT });
}

/** Clone a valid exchange document so a refusal test can damage one protocol field only. */
function cloneDocument(document) {
  return structuredClone(document);
}

/** Replace one board metadata value in a detached export document. */
function setDocumentMeta(document, key, value) {
  const row = document.tables.board_meta.find((entry) => entry.meta_key === key);
  if (row) row.meta_value = value;
  else document.tables.board_meta.push({ meta_key: key, meta_value: value });
}

/** Assert that a rejected snapshot preserves every row and SQLite sequence counter. */
function refusalLeavesRowsAlone(board, document, sequence, code) {
  const before = exportBoard(board);
  assert.throws(() => restoreRelaySnapshot(board, document, sequence), { code });
  assert.deepEqual(exportBoard(board), before, `${code} must not alter rows or AUTOINCREMENT counters`);
}

/** Remove only protocol metadata to compare user-visible board history across a relink. */
function withoutRelayMetadata(document) {
  return {
    ...document,
    tables: {
      ...document.tables,
      board_meta: document.tables.board_meta.filter((row) => !row.meta_key.startsWith('relay_')),
    },
  };
}

test('an acknowledged same-board checkpoint replaces divergent rows and retains its receipt [H3,H16]', (t) => {
  const { source, replica, item, document } = snapshotFixture(t);
  assert.notDeepEqual(exportBoard(replica), document, 'replica starts occupied and divergent');
  assert.equal(appliedSequence(source), 1);
  assert.ok(engineReceipt(source, RECEIPT_ID));

  restoreRelaySnapshot(replica, document, 1);

  assert.deepEqual(exportBoard(replica), document, 'the replica becomes the exact acknowledged prefix');
  assert.equal(store.boardId(replica), store.boardId(source));
  assert.equal(store.getItem(replica, item).item_status, 'claimed');
  assert.equal(appliedSequence(replica), 1);
  assert.deepEqual(engineReceipt(replica, RECEIPT_ID), engineReceipt(source, RECEIPT_ID));
});

test('wrong-board, mismatched/backward coverage and newer-engine checkpoints leave all rows untouched [H3,H16]', (t) => {
  const { replica, document } = snapshotFixture(t);

  const wrongBoard = cloneDocument(document);
  const boardId = document.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value;
  setDocumentMeta(wrongBoard, 'board_id', boardId === 'f'.repeat(32) ? 'e'.repeat(32) : 'f'.repeat(32));
  refusalLeavesRowsAlone(replica, wrongBoard, 1, 'RELAY_SNAPSHOT');

  refusalLeavesRowsAlone(replica, document, 2, 'RELAY_SNAPSHOT');

  replica.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run('relay_applied_sequence', '2');
  refusalLeavesRowsAlone(replica, document, 1, 'RELAY_SNAPSHOT');
  replica.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run('0', 'relay_applied_sequence');

  const futureEngine = cloneDocument(document);
  setDocumentMeta(futureEngine, 'relay_engine_version', String(ENGINE_VERSION + 1));
  refusalLeavesRowsAlone(replica, futureEngine, 1, 'ENGINE_VERSION');
});

test('starting a relay epoch preserves board rows and events while clearing receipts and resetting sequence [H3,H16]', (t) => {
  const { source, document } = snapshotFixture(t);
  const before = exportBoard(source);
  assert.ok(engineReceipt(source, RECEIPT_ID));
  assert.equal(appliedSequence(source), 1);

  startRelayEpoch(source);

  const after = exportBoard(source);
  assert.deepEqual(withoutRelayMetadata(after), withoutRelayMetadata(before), 'items, agents, shouts, verdicts and event history remain intact');
  assert.equal(store.boardId(source), document.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value);
  assert.equal(appliedSequence(source), 0);
  assert.equal(engineReceipt(source, RECEIPT_ID), null);
  assert.equal(source.db.prepare("SELECT COUNT(*) AS count FROM board_meta WHERE meta_key LIKE 'relay_receipt_%'").get().count, 0);
  assert.equal(Number(after.tables.board_meta.find((row) => row.meta_key === 'relay_engine_version').meta_value), ENGINE_VERSION);
});


test('a failed durable receipt rolls back an otherwise successful move and its cursor [H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const board = copies[0];
  const before = exportBoard(board);
  board.db.exec(`CREATE TRIGGER engine_test_abort_receipt BEFORE INSERT ON board_meta
    WHEN NEW.meta_key LIKE 'relay_receipt_%' BEGIN SELECT RAISE(ABORT, 'receipt rollback probe'); END`);
  assert.throws(() => applyEngineMove(board, claimMove(board, item, 'web-1'), { sequence: 1, at: CLAIM_AT }), /receipt rollback probe/);
  assert.deepEqual(exportBoard(board), before, 'receipt failure cannot leave a committed claim without its replay position');
  assert.equal(replayCursor(board), 0);
});
