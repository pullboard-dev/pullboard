/** next --verify selects outside the board write transaction and rechecks only the chosen item inside it [C7,V15]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../index.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import { submitFixture } from '../../../fixtures/submit.js';
import { reviewFamilyRelaxation } from '../../../../src/io/board/review/family.js';
import { confirmRelaxation } from '../../../../src/io/relaxation.js';
import { itemReviewPolicy } from '../../../../../verify/index.js';
import { familiesDiffer } from '../../../../../verify/index.js';
import { seatFamily } from '../../../../../verify/index.js';

const SUBMITTED = 30;
const SEATS = 15;

/** A file board with 30 submissions waiting past the backlog threshold and 15 active seats; core-2 reviews from another family when `crossFamily`. */
function backlog(t, submitted = SUBMITTED, { crossFamily = false } = {}) {
  const board = fixtureBoard(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  board.clock = { now: () => new Date(now) };
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: '/fixture/coordinator', family: 'human', parentDigest: 'a'.repeat(64), model: 'fixture-model' });
  for (let seat = 1; seat <= SEATS; seat++) {
    store.register(board, { id: `core-${seat}`, lane: 'core', path: `/fixture/core-${seat}`, family: crossFamily && seat === 2 ? 'anthropic' : 'openai',
      parentDigest: seat.toString(16).padStart(64, '0'), model: 'fixture-model' });
  }
  const ids = [];
  for (let index = 0; index < submitted; index++) ids.push(submitWaiting(board, index + 1));
  now = new Date(now.getTime() + 16 * 60_000);
  // A reservation holds only while its reviewer's heartbeat is under two minutes old, so every seat is live now.
  for (let seat = 1; seat <= SEATS; seat++) store.heartbeatSeat(board, `core-${seat}`);
  return { board, ids, advance: ms => { now = new Date(now.getTime() + ms); } };
}

/** Submit one more same-family review under the frozen family rule with a backlog threshold of 2. */
function submitWaiting(board, number) {
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: `Waiting review ${number}`, criterion: 'prove it' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
    freeze: () => ({ text: JSON.stringify({ policy: { verify: { family: 'require', familyRelaxAt: 2 } } }), digest: 'fixture-digest' }) });
  submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  return id;
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
  const { board } = backlog(t, SUBMITTED, { crossFamily: true });
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

test('clause 1: through the native command writer, the selection runs before the writer transaction and the hold stays under 500 ms [C7,V15]', t => {
  const { board } = backlog(t, SUBMITTED, { crossFamily: true });
  const holds = writerHolds(board);
  store.nextFor(board, { ...who, verify: true });
  const selection = holds.prepared;
  const before = holds.length;
  const reserved = store.writeBoardCommand(board, 'reserveNextReview', [{ ...who }], who.agentId);
  assert.equal(reserved.item?.item_review_by, 'core-2', 'the writer reserved a review');
  const own = holds.slice(before);
  assert.equal(own.length, 1, 'one writer transaction: ' + JSON.stringify(own));
  assert.ok(own[0].statements < selection, `the writer transaction prepared ${own[0].statements} statements; the selection scan alone prepares ${selection}`);
  assert.ok(own[0].ms < 500, `the writer held the lock ${Math.round(own[0].ms)} ms`); // budget: declared by the item bar's 500 ms write-transaction ceiling.
});

/** The statements the look prepares on a fresh connection's cache, and how long one witness build alone takes. */
function witnessCost(board) {
  const holds = writerHolds(board);
  const item = store.nextFor(board, { ...who, verify: true }).item;
  const started = performance.now();
  assert.ok(reviewFamilyRelaxation(board, store.getItem(board, item.item_id), who.agentId, who.familyRelaxAt, who.policy, who.familyPolicy), 'the fixture relaxes the frozen family rule');
  return { ms: performance.now() - started, statements: holds.prepared };
}

test('clause 1: a same-family reservation over 30 submissions and 15 seats holds its write transaction under 500 ms [C7,V15]', t => {
  const { board } = backlog(t);
  const witness = witnessCost(board);
  const holds = writerHolds(board);
  const reserved = store.reserveNextReview(board, who);
  assert.ok(reserved.item, 'a same-family review is reserved under the relaxed rule');
  const event = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='reserve' ORDER BY event_id DESC LIMIT 1").get(reserved.item.item_id);
  assert.ok(JSON.parse(event.event_detail).familyRelaxation, 'the reservation records its witness');
  assert.ok(holds.length >= 1, 'the reservation wrote through a real transaction');
  const longest = Math.max(...holds.map(hold => hold.ms));
  const inLock = Math.max(...holds.map(hold => hold.statements));
  assert.ok(inLock < witness.statements, `the transaction prepared ${inLock} statements; the look alone prepares ${witness.statements}`);
  assert.ok(longest < 500, `the longest writer hold was ${Math.round(longest)} ms (one witness build takes ${Math.round(witness.ms)} ms)`); // budget: declared by the item bar's 500 ms write-transaction ceiling.
});

test('clause 1: a same-family reservation through the native command writer holds the lock under 500 ms [C7,V15]', t => {
  const { board } = backlog(t);
  const witness = witnessCost(board);
  const holds = writerHolds(board);
  const reserved = store.writeBoardCommand(board, 'reserveNextReview', [{ ...who }], who.agentId);
  assert.equal(reserved.item?.item_review_by, 'core-2', 'the writer reserved a same-family review');
  assert.equal(holds.length, 1, 'one writer transaction: ' + JSON.stringify(holds));
  assert.ok(holds[0].statements < witness.statements, `the writer transaction prepared ${holds[0].statements} statements; the look alone prepares ${witness.statements}`);
  assert.ok(holds[0].ms < 500, `the writer held the lock ${Math.round(holds[0].ms)} ms`); // budget: declared by the item bar's 500 ms write-transaction ceiling.
});

test('clause 2: the lock confirms the witness built before it and never rebuilds the queue-wide witness [C7,V15]', t => {
  const { board } = backlog(t);
  // The builder is active before the look too, so the arriving submission leaves the free seats unchanged.
  store.shout(board, { from: 'core-1', to: 'coordinator', text: 'Building', lanes: ['core'] });
  let before = null, looks = 0;
  const reserved = store.reserveNextReview(board, who, { afterSelection: item => {
    looks++;
    if (before) return;
    before = reviewFamilyRelaxation(board, store.getItem(board, item.item_id), who.agentId, who.familyRelaxAt, who.policy, who.familyPolicy);
    // One more blocked review arrives after the look: a witness rebuilt in the lock would count it.
    submitWaiting(board, SUBMITTED + 1);
  } });
  assert.equal(before.queueLength, SUBMITTED, 'the look saw the original backlog');
  assert.equal(looks, 1, 'the lock confirmed the first look; nothing looked again');
  const event = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='reserve' ORDER BY event_id DESC LIMIT 1").get(reserved.item.item_id);
  assert.deepEqual(JSON.parse(event.event_detail).familyRelaxation, before, 'the recorded witness is the confirmed one from before the lock, not a rebuild');
});

/** The witness ports, with every item read inside the confirmation counted. */
function countingPorts(board) {
  const read = [];
  return { read, ports: { reviewerChecks: store.reviewerChecks, reviewHolder: store.reviewHolder, reviewReleaseCooldown: store.reviewReleaseCooldown,
    listItems: store.listItems, seatFamily, familiesDiffer, itemReviewPolicy,
    getItem: (b, id) => { read.push(id); return store.getItem(b, id); } } };
}

test('clause 2: the in-lock confirmation reads at most the threshold of witness entries, and the first stale one gives up [C7,V15]', t => {
  const { board, ids } = backlog(t);
  const subject = store.getItem(board, ids[0]);
  const witness = reviewFamilyRelaxation(board, subject, who.agentId, who.familyRelaxAt, who.policy, who.familyPolicy);
  assert.ok(witness, 'the fixture relaxes the frozen family rule');
  // A long stale list: a thousand reviews that no longer exist come before every live one.
  const stale = { ...witness, waiting: [...Array.from({ length: 1000 }, (_, index) => 100_000 + index), ...witness.waiting] };
  const staleRun = countingPorts(board);
  assert.equal(confirmRelaxation(board, subject, stale, who.agentId, who.familyRelaxAt, who.policy, staleRun.ports), null, 'a stale entry relaxes nothing');
  assert.ok(staleRun.read.length <= who.familyRelaxAt - 1, `read ${staleRun.read.length} other entries of ${stale.waiting.length}`);
  // A live witness of thirty is confirmed from its first threshold entries alone.
  const liveRun = countingPorts(board);
  assert.deepEqual(confirmRelaxation(board, subject, witness, who.agentId, who.familyRelaxAt, who.policy, liveRun.ports), witness);
  assert.ok(liveRun.read.length <= who.familyRelaxAt - 1, `read ${liveRun.read.length} other entries of ${witness.waiting.length}`);
});

test('clause 1: next --take reserving a named same-family review through the writer holds the lock under 500 ms [C7,V15]', t => {
  const { board, ids } = backlog(t);
  const holds = writerHolds(board);
  const reserved = store.writeBoardCommand(board, 'reserveReview', [ids[0], { ...who }], who.agentId);
  assert.equal(reserved.item_review_by, 'core-2', 'the writer reserved the named review');
  assert.equal(holds.length, 1, 'one writer transaction: ' + JSON.stringify(holds));
  assert.ok(holds[0].ms < 500, `the writer held the lock ${Math.round(holds[0].ms)} ms`); // budget: declared by the item bar's 500 ms write-transaction ceiling.
});

test('clause 2: a named reservation through the writer builds its witness before the lock, never inside it [C7,V15]', t => {
  const { board, ids } = backlog(t);
  // The builder is active before the look too, so the arriving submission leaves the free seats unchanged.
  store.shout(board, { from: 'core-1', to: 'coordinator', text: 'Building', lanes: ['core'] });
  const before = reviewFamilyRelaxation(board, store.getItem(board, ids[0]), who.agentId, who.familyRelaxAt, who.policy, who.familyPolicy);
  assert.equal(before.queueLength, SUBMITTED);
  // One more blocked review lands just before the writer's transaction opens: a witness built in the lock would count it.
  const exec = board.db.exec.bind(board.db);
  let armed = true;
  board.db.exec = sql => {
    if (armed && /^\s*BEGIN\s+IMMEDIATE/iu.test(sql)) { armed = false; board.db.exec = exec; submitWaiting(board, SUBMITTED + 1); }
    return exec(sql);
  };
  const reserved = store.writeBoardCommand(board, 'reserveReview', [ids[0], { ...who }], who.agentId);
  assert.equal(reserved.item_review_by, 'core-2');
  const event = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='reserve' ORDER BY event_id DESC LIMIT 1").get(ids[0]);
  assert.deepEqual(JSON.parse(event.event_detail).familyRelaxation, before, 'the recorded witness is the one built before the lock');
});

test('clause 2: an item another reviewer took between the look and the lock is selected again, never reserved twice [C7,V15]', t => {
  const { board } = backlog(t, SUBMITTED, { crossFamily: true });
  const seen = [];
  const reserved = store.reserveNextReview(board, who, { afterSelection: item => {
    seen.push(item.item_id);
    // Another reviewer takes the chosen item after the look and before the lock.
    if (seen.length === 1) store.reserveReview(board, item.item_id, { ...who, agentId: 'core-3', familyPolicy: 'off' });
  } });
  assert.equal(seen.length, 2, 'the changed choice was made again');
  assert.notEqual(reserved.item.item_id, seen[0], 'the item another reviewer took is not reserved twice');
  assert.equal(store.getItem(board, seen[0]).item_review_by, 'core-3');
  assert.equal(reserved.item.item_review_by, 'core-2');
});

test('clause 2: a cross-family reservation rechecks only its pair in the lock, with no relaxation witness [C7,V15]', t => {
  const { board } = backlog(t, SUBMITTED, { crossFamily: true });
  const reserved = store.reserveNextReview(board, who);
  const event = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='reserve' ORDER BY event_id DESC LIMIT 1").get(reserved.item.item_id);
  assert.equal(JSON.parse(event.event_detail).familyRelaxation, undefined, 'an ordinary pair needs no witness');
});

test('clause 3: a same-family witness is built before the lock, confirmed inside it, and matches the in-lock result [C7,V15]', t => {
  const { board } = backlog(t);
  const expected = store.atomic(board, () => store.nextFor(board, { ...who, verify: true }).item);
  const witness = store.atomic(board, () => reviewFamilyRelaxation(board, store.getItem(board, expected.item_id), who.agentId, who.familyRelaxAt, who.policy, who.familyPolicy));
  assert.ok(witness, 'the fixture backlog relaxes the frozen family rule');
  const reserved = store.reserveNextReview(board, who);
  assert.equal(reserved.item.item_id, expected.item_id);
  const event = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='reserve' ORDER BY event_id DESC LIMIT 1").get(expected.item_id);
  assert.deepEqual(JSON.parse(event.event_detail).familyRelaxation, witness);
});

test('clause 2: a same-family witness whose queue changed between the look and the lock relaxes nothing [C7,V15]', t => {
  const { board, ids } = backlog(t, 2);
  let chosen;
  const reserved = store.reserveNextReview(board, who, { afterSelection: item => {
    if (chosen) return;
    chosen = item.item_id;
    // Another same-family reviewer takes the other waiting item, so only one review waits: under the threshold of 2.
    store.reserveReview(board, ids.find(id => id !== item.item_id), { ...who, agentId: 'core-3' });
  } });
  assert.equal(reserved.item, null, 'the confirmed witness no longer relaxes the frozen family rule');
  assert.equal(store.getItem(board, chosen).item_review_by, null, 'the chosen item is not reserved on a stale look');
});

test('clause 2: a seat leaving its release cooldown between the look and the lock is seen by the in-lock witness [C7,V15]', t => {
  const { board, ids, advance } = backlog(t, 2);
  store.register(board, { id: 'core-99', lane: 'core', path: '/fixture/core-99', family: 'anthropic',
    parentDigest: 'f'.repeat(64), model: 'fixture-model' });
  // The other-family seat reviews and releases both waiting items, so its hour-long cooldown blocks it on each.
  for (const id of ids) {
    store.reserveReview(board, id, { ...who, agentId: 'core-99', familyPolicy: 'require' });
    store.release(board, id, 'core-99', 'Fixture reviewer steps away.', undefined, 'OTHER');
  }
  advance(50 * 60_000);
  store.shout(board, { from: 'core-99', to: 'coordinator', text: 'Still here', lanes: ['core'] });
  advance(9 * 60_000 + 59_000);
  let chosen;
  const reserved = store.reserveNextReview(board, who, { afterSelection: item => {
    if (chosen) return;
    chosen = item.item_id;
    // Its cooldown ends while it is still active: it can now review, so the backlog no longer relaxes the rule.
    advance(2_000);
  } });
  assert.equal(reserved.item, null, 'the look after the cooldown ended no longer relaxes the frozen family rule');
  assert.equal(store.getItem(board, chosen).item_review_by, null, 'the chosen item is not reserved on a stale look');
});

test('clause 2: next --verify renews the caller\'s own live reservation in the lock [C7,V15]', t => {
  const { board, advance } = backlog(t);
  const first = store.reserveNextReview(board, who);
  const until = first.item.item_review_until;
  advance(60_000);
  const renewed = store.reserveNextReview(board, who);
  assert.equal(renewed.item.item_id, first.item.item_id, 'the same review is renewed');
  assert.ok(renewed.item.item_review_until > until, 'the lease moved forward');
});
