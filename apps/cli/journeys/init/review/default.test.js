/** Synthetic native lifecycle contracts exercise real guards; none are landing proof [V4,B26,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { closeBoard } from '../../../../lib/index.js';
import { fixtureBoard } from '../../../tests/fixtures/board.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { itemReviewPolicy } from '../../../../../packages/verify/index.js';
import { reviewEligibility } from '../../../../../packages/verify/index.js';
import { REVIEW_TIER_ENGINE } from '../../../../../packages/state/light.js';
import { REVIEW_DEFAULT_ENGINE } from '../../../../../packages/state/light.js';
import { prepareEngineMove } from '../../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../../packages/state/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import { healthLines } from '../../../../../packages/health/index.js';
import { withOpenedBoard } from '../../../index.js';
import { atomic } from '../../../../../packages/store/index.js';

const LEASE = 3_600_000;

/** Declare identities and run production moves with explicit synthetic lifecycle evidence. */
function fixture(t, { historical = false, storage = 'memory' } = {}) {
  const board = fixtureBoard(t, storage === 'file' ? { storage, purpose: 'migration' } : {});
  if (historical) board.executionEngineVersion = REVIEW_TIER_ENGINE;
  for (const [id, family, parent] of [['coordinator', 'human', 'e'], ['core-1', 'OpenAI', 'a'],
    ['core-2', 'OpenAI', 'b'], ['core-3', 'Anthropic', 'c'], ['core-4', 'Anthropic', 'a']]) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`,
      model: 'Explicit fixture model', family, parentDigest: parent.repeat(64) });
  }
  const add = () => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Explicit review default fixture',
    check: 'node apps/cli/src/io/run/tests.js apps/cli/journeys/init/review/default.test.js' });
  const submit = (id, { files = ['src/quarantine.js'] } = {}) => {
    store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: LEASE,
      freeze: () => ({ text: JSON.stringify({ policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'synthetic-default-bar' }) });
    submitFixture(board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40), files });
    return store.getItem(board, id);
  };
  const reserve = (id, agentId) => store.reserveReview(board, id, { agentId, leaseMs: LEASE, policy: 'any', familyPolicy: 'off' });
  return { board, add, submit, reserve };
}

/** Read the durable board event through the ordinary event projection. */
function migrationEvents(board) { return store.events(board).filter(event => event.event_kind === 'review-default'); }

/** Durable normalization records are native snapshot metadata, not local console state. */
function records(board) {
  return board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'review_default:normalized:%' ORDER BY meta_key")
    .all().map(row => JSON.parse(row.meta_value));
}

test('ordinary judgment-path work permits another same-vendor session while builder and shared-parent guards remain [V4,B26,H16]', t => {
  const f = fixture(t), id = f.add(), item = f.submit(id);
  assert.equal(itemReviewPolicy(f.board, id).tier, 'standard');
  const eligibility = reviewEligibility(f.board, item);
  assert.ok(eligibility.eligible.includes('core-2'));
  assert.ok(!eligibility.eligible.includes('core-1'));
  assert.ok(!eligibility.eligible.includes('core-4'));
  assert.throws(() => f.reserve(id, 'core-1'), { code: 'SELF_VERIFY' });
  assert.throws(() => f.reserve(id, 'core-4'));
  assert.equal(f.reserve(id, 'core-2').item_review_by, 'core-2');
});

test('sensitive and explicit family marks retain strict cross-vendor admission [V4,B26,H16]', t => {
  for (const mark of [{ sensitive: true }, { reviewFamily: 'Anthropic' }]) {
    const f = fixture(t), id = f.add();
    store.editItem(f.board, id, { agentId: 'coordinator', ...mark });
    f.submit(id);
    assert.equal(itemReviewPolicy(f.board, id).tier, 'strict');
    assert.throws(() => f.reserve(id, 'core-2'), { code: mark.reviewFamily ? 'REQUIRED_REVIEW_FAMILY' : 'SAME_FAMILY' });
    assert.equal(f.reserve(id, 'core-3').item_review_by, 'core-3');
  }
});

test('manual strict aliases sensitive, preserves its reason and cannot be cleared through optional fields [V4,B26,H16]', t => {
  const f = fixture(t), id = f.add();
  store.editItem(f.board, id, { agentId: 'coordinator', reviewTier: 'strict', reason: 'Deliberately sensitive review.' });
  store.editItem(f.board, id, { agentId: 'coordinator', sensitive: false, reviewFamily: null });
  const policy = itemReviewPolicy(f.board, id);
  assert.equal(policy.sensitive, true);
  assert.equal(policy.reviewTier, 'strict');
  assert.equal(policy.tier, 'strict');
  assert.ok(store.events(f.board).some(event => event.event_kind === 'edit'
    && JSON.parse(event.event_detail).reason === 'Deliberately sensitive review.'));
  assert.deepEqual(records(f.board), []);
});

test('legacy implicit strict changes on the next successful write and reports once without health replay [V4,B26,H16]', t => {
  const f = fixture(t, { historical: true }), first = f.add(), second = f.add(), explicit = f.add();
  f.submit(first);
  // Release the first build before claiming the next independent fixture item.
  f.submit(second);
  store.editItem(f.board, explicit, { agentId: 'coordinator', reviewTier: 'strict', reason: 'Keep this deliberate mark.' });
  delete f.board.executionEngineVersion;
  assert.equal(itemReviewPolicy(f.board, first).tier, 'strict', 'a read does not migrate');
  assert.deepEqual(records(f.board), []);
  store.appendFact(f.board, first, { agentId: 'coordinator', kind: 'note', text: 'First modern write.' });
  assert.equal(itemReviewPolicy(f.board, first).tier, 'standard');
  assert.equal(itemReviewPolicy(f.board, second).tier, 'standard');
  assert.equal(itemReviewPolicy(f.board, explicit).tier, 'strict');
  const changed = records(f.board);
  const migration = migrationEvents(f.board);
  assert.equal(migration.length, 1);
  assert.equal(migration[0].event_by, 'board');
  assert.deepEqual(JSON.parse(migration[0].event_detail), { engine: REVIEW_DEFAULT_ENGINE, count: 2, unfinished: [first, second] });
  assert.deepEqual(changed.map(row => row.item), [first, second]);
  const lines = f.board.reviewDefaultNotice;
  assert.equal(lines[0], '2 items moved to standard review.');
  for (const id of [first, second]) assert.ok(lines.some(line => line.startsWith(`#${id} review normalized from strict to standard:`)));
  assert.deepEqual(healthLines({ stuck: [], waiting: [], reviewNormalizations: changed }), ['nothing is stuck']);
  store.appendFact(f.board, second, { agentId: 'coordinator', kind: 'note', text: 'Repeated modern write.' });
  assert.deepEqual(records(f.board), changed);
  assert.deepEqual(migrationEvents(f.board), migration, 'a later write records no repeated event');
  const replica = fixtureBoard(t);
  importBoard(replica, exportBoard(f.board));
  assert.deepEqual(records(replica), changed);
  assert.deepEqual(migrationEvents(replica), migration, 'the person can find it after snapshot transfer');
  assert.equal(itemReviewPolicy(replica, first).tier, 'standard');
});

test('a refused write rolls back normalization and its notice atomically [V4,B26,H16]', t => {
  const f = fixture(t, { historical: true }), id = f.add();
  f.submit(id);
  delete f.board.executionEngineVersion;
  const before = exportBoard(f.board);
  assert.throws(() => store.editItem(f.board, id, { agentId: 'core-2', sensitive: true }), { code: 'NOT_YOURS' });
  assert.deepEqual(exportBoard(f.board), before);
  assert.equal(itemReviewPolicy(f.board, id).tier, 'strict');
  assert.equal(f.board.reviewDefaultNotice, undefined);
  assert.throws(() => atomic(f.board, () => {
    store.appendFact(f.board, id, { agentId: 'coordinator', kind: 'note', text: 'Rolled back outer move.' });
    assert.ok(f.board.reviewDefaultNotice);
    throw new Error('outer rollback');
  }), /outer rollback/);
  assert.equal(f.board.reviewDefaultNotice, undefined);
  assert.deepEqual(exportBoard(f.board), before);
});

test('ordered historical reservations and duplicate receipts stay stable across activation; fresh old envelopes are fenced [V4,B26,H16]', t => {
  const f = fixture(t, { historical: true }), id = f.add();
  f.board.executionEngineVersion = REVIEW_TIER_ENGINE - 1;
  f.submit(id);
  const old = { ...prepareEngineMove(f.board, 'reserveReview', [id, { agentId: 'core-2', leaseMs: LEASE,
    policy: 'any', familyPolicy: 'off' }], { id: 'pre-default-reservation' }), engine: REVIEW_TIER_ENGINE - 1 };
  const at = f.board.clock.now().toISOString();
  const first = applyEngineMove(f.board, old, { sequence: 1, at });
  assert.equal(first.error, undefined);
  assert.deepEqual(records(f.board), []);
  delete f.board.executionEngineVersion;
  const modern = prepareEngineMove(f.board, 'appendFact', [id, { agentId: 'coordinator', kind: 'note', text: 'Modern activation.' }]);
  const activated = applyEngineMove(f.board, modern, { sequence: 2, at });
  assert.equal(activated.error, undefined);
  const migration = migrationEvents(f.board);
  assert.equal(migration.length, 1);
  assert.deepEqual(activated.events.filter(event => event.event_kind === 'review-default'), migration.map(event => ({ ...event })), 'ordered receipt contains the committed migration');
  assert.deepEqual(applyEngineMove(f.board, modern, { sequence: 2, at }), activated, 'duplicate modern receipt replays without another event');
  assert.equal(itemReviewPolicy(f.board, id).tier, 'standard');
  const snapshot = exportBoard(f.board);
  assert.deepEqual(applyEngineMove(f.board, old, { sequence: 1, at }), first);
  assert.deepEqual(exportBoard(f.board), snapshot);
  const stale = { ...prepareEngineMove(f.board, 'reserveReview', [id, { agentId: 'core-3', leaseMs: LEASE,
    policy: 'any', familyPolicy: 'off' }]), engine: REVIEW_DEFAULT_ENGINE - 1 };
  assert.throws(() => applyEngineMove(f.board, stale, { sequence: 3, at }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(f.board), snapshot);
});


test('explicit-only defaults keep unsafe companion path refusal atomic [V4,H16]', t => {
  const f = fixture(t), id = f.add(), item = f.submit(id);
  // Keep the original path guard's docs inventory case, so it must inspect companion paths.
  const docs = f.add();
  store.claim(f.board, docs, { agentId: 'core-1', lane: 'core', leaseMs: LEASE,
    freeze: () => ({ text: '{}', digest: 'synthetic-companion-bar' }) });
  submitFixture(f.board, docs, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40), files: ['README.md'] });
  const patch = 'diff --git a/../escape.js b/../escape.js\n--- a/../escape.js\n+++ b/../escape.js\n@@ -1 +1 @@\n-old\n+new\n';
  const before = exportBoard(f.board);
  assert.throws(() => store.attachItemPatch(f.board, docs, { agentId: 'coordinator', key: 'unsafe-companion', commit: item.item_commit,
    patch, author: 'core-1' }), { code: 'ITEM_PATCH' });
  assert.deepEqual(exportBoard(f.board), before);
});


test('opening an existing board leaves implicit tiers and historical snapshots untouched until a native write [V4,H16]', t => {
  const f = fixture(t, { historical: true, storage: 'file' }), id = f.add();
  f.submit(id);
  const before = exportBoard(f.board);
  const file = f.board.db.prepare('PRAGMA database_list').get().file;
  // @pullboard-board-file migration: reopening an old snapshot must not activate new review policy.
  const reopened = openBoard(file);
  let closed = false;
  try {
    assert.equal(itemReviewPolicy(reopened, id).tier, 'strict');
    assert.deepEqual(records(reopened), []);
    assert.deepEqual(exportBoard(reopened), before);
    const printed = [];
    const ctx = { info: { root: '/fixture', isMain: true }, io: { err: line => printed.push(line) } };
    try { withOpenedBoard(ctx, board => {
      store.appendFact(board, id, { agentId: 'coordinator', kind: 'note', text: 'First reopened modern write.' });
    }, reopened); } finally { closed = true; }
    assert.equal(printed.length, 2);
    // @pullboard-board-file migration: a later connection must not repeat a committed migration notice.
    const later = openBoard(file);
    withOpenedBoard(ctx, board => {
      assert.equal(board.reviewDefaultNotice, undefined);
      store.appendFact(board, id, { agentId: 'coordinator', kind: 'note', text: 'Later connection write.' });
      assert.equal(board.reviewDefaultNotice, undefined);
      assert.equal(migrationEvents(board).length, 1);
    }, later);
    assert.equal(printed.length, 2, 'a subsequent connection never prints the notice again');
  } finally { if (!closed) closeBoard(reopened); }
});


test('committed migration prints one bounded notice and excludes finished work from item lines [V4,H16]', t => {
  const cleanup = [];
  const f = fixture({ after: fn => cleanup.push(fn) }, { historical: true });
  let closed = false;
  t.after(() => { if (!closed) for (const fn of cleanup) fn(); });
  const finished = [];
  for (let i = 0; i < 60; i += 1) {
    const id = f.add();
    f.submit(id);
    f.reserve(id, 'core-3');
    const item = store.getItem(f.board, id);
    store.logEvent(f.board, 'core-3', 'proof-run', id, { receipt: { kind: 'verdict' } });
    store.verify(f.board, id, { agentId: 'core-3', decision: 'ACCEPT', note: 'Synthetic historical state only; not landing evidence.',
      head: item.item_commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off', check: 'none' });
    finished.push(id);
  }
  const unfinished = f.add();
  f.submit(unfinished);
  delete f.board.executionEngineVersion;
  const printed = [];
  const ctx = { info: { root: '/fixture', isMain: true }, io: { err: line => printed.push(line) } };
  try { withOpenedBoard(ctx, board => {
    store.appendFact(board, unfinished, { agentId: 'coordinator', kind: 'note', text: 'Committed activation.' });
    assert.deepEqual(printed, [], 'no output while a command owns the board');
    store.appendFact(board, unfinished, { agentId: 'coordinator', kind: 'note', text: 'No repeated activation.' });
    assert.equal(records(board).length, finished.length + 1);
    assert.equal(migrationEvents(board).length, 1);
    assert.deepEqual(JSON.parse(migrationEvents(board)[0].event_detail), { engine: REVIEW_DEFAULT_ENGINE, count: 61, unfinished: [unfinished] });
    assert.deepEqual(healthLines({ stuck: [], waiting: [] }), ['nothing is stuck']);
  }, f.board); } finally { closed = true; }
  assert.equal(printed.length, 2);
  assert.equal(printed[0], '61 items moved to standard review.');
  assert.ok(printed[1].startsWith(`#${unfinished} review normalized`));
  for (const id of finished) assert.ok(!printed.some(line => line.startsWith(`#${id} `)));
});


test('normalizing a different item preserves genuine older review moves and duplicate receipts [V4,B26,H16]', t => {
  const f = fixture(t, { historical: true }), changed = f.add(), ordinary = f.add();
  f.submit(changed);
  f.submit(ordinary, { files: ['README.md'] });
  const old = { ...prepareEngineMove(f.board, 'reserveReview', [ordinary, { agentId: 'core-2', leaseMs: LEASE,
    policy: 'any', familyPolicy: 'off' }], { id: 'unrelated-pre-default-reservation' }), engine: REVIEW_DEFAULT_ENGINE - 1 };
  delete f.board.executionEngineVersion;
  const at = f.board.clock.now().toISOString();
  const modern = prepareEngineMove(f.board, 'appendFact', [changed, { agentId: 'coordinator', kind: 'note', text: 'Normalize only implicit judgment work.' }]);
  const activated = applyEngineMove(f.board, modern, { sequence: 1, at });
  assert.equal(activated.error, undefined);
  assert.deepEqual(records(f.board).map(row => row.item), [changed], 'the ordinary item has no changed-policy witness');
  const replica = fixtureBoard(t);
  importBoard(replica, exportBoard(f.board));
  const first = applyEngineMove(f.board, old, { sequence: 2, at });
  assert.equal(first.error, undefined, 'a different item’s migration cannot fence this genuine older envelope');
  assert.equal(store.getItem(f.board, ordinary).item_review_by, 'core-2');
  assert.deepEqual(applyEngineMove(replica, old, { sequence: 2, at }), first, 'the same historical move replays on the transferred snapshot');
  assert.deepEqual(exportBoard(replica), exportBoard(f.board));
  const snapshot = exportBoard(f.board);
  assert.deepEqual(applyEngineMove(f.board, old, { sequence: 2, at }), first, 'the exact old receipt stays stable');
  assert.deepEqual(exportBoard(f.board), snapshot);
  assert.equal(migrationEvents(f.board).length, 1);
});
