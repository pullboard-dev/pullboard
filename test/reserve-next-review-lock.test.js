/** next --verify selects outside the board write transaction and rechecks only the chosen item inside it [C7,V15]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { fixtureBoard } from './board-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { reviewFamilyRelaxation } from '../packages/store/src/shell/board-review-family.js';

const SUBMITTED = 30;
const SEATS = 15;

/** A file board with 30 same-family submissions waiting past the backlog threshold and 15 active seats. */
function backlog(t) {
  const board = fixtureBoard(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  board.clock = { now: () => new Date(now) };
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: '/fixture/coordinator', family: 'human', parentDigest: 'a'.repeat(64), model: 'fixture-model' });
  for (let seat = 1; seat <= SEATS; seat++) {
    store.register(board, { id: `core-${seat}`, lane: 'core', path: `/fixture/core-${seat}`, family: 'openai',
      parentDigest: seat.toString(16).padStart(64, '0'), model: 'fixture-model' });
  }
  const ids = [];
  for (let index = 0; index < SUBMITTED; index++) {
    const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: `Waiting review ${index + 1}`, criterion: 'prove it' });
    store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
      freeze: () => ({ text: JSON.stringify({ policy: { verify: { family: 'require', familyRelaxAt: 2 } } }), digest: 'fixture-digest' }) });
    submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
    ids.push(id);
  }
  now = new Date(now.getTime() + 16 * 60_000);
  return { board, ids };
}

/** Record how long each top-level write transaction holds the SQLite writer, from BEGIN to its end. */
function writerHolds(board) {
  const holds = [], exec = board.db.exec.bind(board.db), prepare = board.db.prepare.bind(board.db);
  let began = null, statements = 0;
  board.db.exec = sql => {
    if (/^\s*BEGIN\s+IMMEDIATE/iu.test(sql)) { began = performance.now(); statements = 0; }
    const result = exec(sql);
    if (began !== null && /^\s*(?:COMMIT|ROLLBACK)\s*$/iu.test(sql)) { holds.push({ ms: performance.now() - began, statements }); began = null; }
    return result;
  };
  board.db.prepare = sql => { if (began !== null) statements++; holds.prepared++; return prepare(sql); };
  holds.prepared = 0;
  return holds;
}

const who = { agentId: 'core-2', lane: 'core', leaseMs: 3_600_000, policy: 'any', familyPolicy: 'require', familyRelaxAt: 2 };

test('clause 1: reserving the next review over 30 submissions and 15 seats holds its write transaction under 500 ms [C7,V15]', t => {
  const { board } = backlog(t);
  const holds = writerHolds(board);
  store.nextFor(board, { ...who, verify: true });
  const selection = holds.prepared;
  const reserved = store.reserveNextReview(board, who);
  assert.ok(reserved.item, 'a review is reserved');
  assert.ok(holds.length >= 1, 'the reservation wrote through a real transaction');
  const longest = Math.max(...holds.map(hold => hold.ms));
  const inLock = Math.max(...holds.map(hold => hold.statements));
  assert.ok(inLock < selection, `the transaction prepared ${inLock} statements; the selection scan alone prepares ${selection}`);
  assert.ok(longest < 500, `the longest writer hold was ${Math.round(longest)} ms`); // budget: declared by the item bar's 500 ms write-transaction ceiling.
});

test('clause 2: an item changed between the look and the lock is selected again, never reserved stale [C7,V15]', t => {
  const { board } = backlog(t);
  const seen = [];
  const reserved = store.reserveNextReview(board, who, { afterSelection: item => {
    seen.push(item.item_id);
    // Another reviewer takes the chosen item after the look and before the lock.
    if (seen.length === 1) store.reserveReview(board, item.item_id, { ...who, agentId: 'core-3' });
  } });
  assert.equal(seen.length, 2, 'the changed choice was made again');
  assert.notEqual(reserved.item.item_id, seen[0], 'the item another reviewer took is not reserved twice');
  assert.equal(store.getItem(board, seen[0]).item_review_by, 'core-3');
  assert.equal(reserved.item.item_review_by, 'core-2');
});

test('clause 3: the reserved item and its family-relaxation witness match the in-lock result [C7,V15]', t => {
  const { board } = backlog(t);
  const expected = store.atomic(board, () => store.nextFor(board, { ...who, verify: true }).item);
  const witness = store.atomic(board, () => reviewFamilyRelaxation(board, store.getItem(board, expected.item_id), who.agentId, who.familyRelaxAt, who.policy, who.familyPolicy));
  assert.ok(witness, 'the fixture backlog relaxes the frozen family rule');
  const reserved = store.reserveNextReview(board, who);
  assert.equal(reserved.item.item_id, expected.item_id);
  const event = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='reserve' ORDER BY event_id DESC LIMIT 1").get(expected.item_id);
  assert.deepEqual(JSON.parse(event.event_detail).familyRelaxation, witness);
});
