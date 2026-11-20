/** A parent reject sends back each dependent built on it through an after-gate marker, and only those [C7,#11807]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { heartbeatSeat } from '../../../index.js';
import { setAfterGate } from '../../../src/io/board/item/after-gate.js';

// fixture-subject: addItem (a store unit test of the verify writer over hand-built items)
const SYNTHETIC_MODEL = 'Synthetic fixture model';
const TREE = 'b'.repeat(40), LANDED = 'c'.repeat(40);
const REVIEW = { policy: 'any', familyPolicy: 'off' };
const CLAUSE = 'the fixture keeps its behavior';

/** A board with a coordinator, a reviewer (core-9) and builders core-1 to core-4, all live. */
function seeded(t) {
  const board = fixtureBoard(t);
  for (const id of ['coordinator', 'core-1', 'core-2', 'core-3', 'core-4', 'core-9']) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, model: SYNTHETIC_MODEL });
    heartbeatSeat(board, id);
  }
  const claimed = (title, agentId, pace) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'core', title, criterion: `1. ${CLAUSE} [test]` });
    store.claim(board, id, { agentId, lane: 'core', leaseMs: 3_600_000, freeze: () => ({ text: JSON.stringify({ criterion: `1. ${CLAUSE} [test]`, ...(pace ? { pace } : {}) }), digest: `synthetic-${title}` }) });
    return id;
  };
  const submitted = (title, agentId, commit, pace) => {
    const id = claimed(title, agentId, pace);
    store.submit(board, id, { agentId, commit, tree: TREE, files: [],
      submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic native board-state fixture; no execution proof' } });
    return id;
  };
  return { board, claimed, submitted };
}

/** Reject the submitted parent as core-9 with the sealed review the CLI records. */
function reject(board, id) {
  const item = store.getItem(board, id);
  return store.verify(board, id, { agentId: 'core-9', decision: 'REJECT', reason: 'TEST_FAILURE', clause: CLAUSE, head: item.item_commit, digest: item.item_frozen_digest,
    note: 'Synthetic dependent send-back fixture reject.', ...REVIEW, review: { commit: item.item_commit, head: item.item_commit, trunk: LANDED, paths: [] } });
}

const status = (board, id) => store.getItem(board, id).item_status;
const reopens = (board, id) => board.db.prepare("SELECT event_detail d FROM event WHERE item_id=? AND event_kind='reopen'").all(id).map(row => JSON.parse(row.d));
const noteTexts = (board, id) => board.db.prepare("SELECT event_detail d FROM event WHERE item_id=? AND event_kind='fact'").all(id).map(row => row.d);

test('store.io-board-verify.reject-sends-dependents-back: clause 1: rejecting a parent reopens each claimed or submitted dependent that has an after-gate marker for it, with a note naming the parent, and leaves a plain --after dependent alone [C7,#11807]', t => {
  const { board, claimed, submitted } = seeded(t);
  const parent = submitted('Parent', 'core-1', 'a'.repeat(40));
  const building = claimed('Claimed dependent', 'core-2');
  const built = submitted('Submitted dependent', 'core-3', 'd'.repeat(40));
  const plain = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Plain after dependent', criterion: `1. ${CLAUSE} [test]`, after: [parent] });
  setAfterGate(board, building, [parent]);
  setAfterGate(board, built, [parent]);
  assert.equal(reject(board, parent).decision, 'REJECT');
  assert.equal(status(board, built), 'open', 'the submitted dependent is reopened');
  assert.match(reopens(board, built)[0].note, new RegExp(`#${parent}\\b`, 'u'), 'its reopen note names the parent');
  assert.equal(status(board, building), 'open', 'the claimed dependent is returned');
  assert.equal(store.getItem(board, building).item_owner, null, 'and no seat holds it');
  assert.equal(status(board, plain), 'open', 'the plain --after dependent stays as it was');
  assert.equal(reopens(board, plain).length, 0, 'with no reopen recorded');
});

test('store.io-board-verify.landed-dependent-gets-notice: clause 2: a dependent already landed gets a notice fact and no reopen when its after-gate parent is rejected [C7,#11807]', t => {
  const { board, submitted } = seeded(t);
  const parent = submitted('Parent', 'core-1', 'a'.repeat(40));
  const landed = submitted('Landed dependent', 'core-3', 'd'.repeat(40), 'sprint');
  setAfterGate(board, landed, [parent]);
  store.merged(board, landed, { agentId: 'coordinator', commit: LANDED });
  assert.equal(reject(board, parent).decision, 'REJECT');
  assert.equal(reopens(board, landed).length, 0, 'no reopen');
  assert.notEqual(status(board, landed), 'open', 'the landed item stays landed');
  assert.ok(noteTexts(board, landed).some(text => text.includes(`#${parent}`) && text.includes('already landed')), 'a notice fact names the parent');
});

const LOW = [{ id: 'row-1', stakes: 'low', personApproved: true }];
const MACHINE = [{ machineRun: true, redBefore: true, greenAfter: true }];

/** A submitted item whose frozen record carries one low-stakes row, built by core-1. */
function soloItem(board, title, stakes = 'low') {
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title, criterion: `1. ${CLAUSE} [test]` });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
    freeze: () => ({ text: JSON.stringify({ criterion: `1. ${CLAUSE} [test]`, rows: [{ id: 'row-1', stakes }], policy: { version: 1, commit: LANDED, verify: { policy: 'any', family: 'off' } } }), digest: `synthetic-${title}` }) });
  store.submit(board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: TREE, files: [],
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic native board-state fixture; no execution proof' } });
  return id;
}

/** The builder's own verify call, with the sealed review the CLI records and the solo facts as given. */
function builderVerify(board, id, decision, solo) {
  board.executionEngineVersion = store.ENGINE_VERSION; // the verify table decides only on a board that runs an engine
  const item = store.getItem(board, id);
  return store.verify(board, id, { agentId: 'core-1', decision, ...(decision === 'REJECT' ? { reason: 'TEST_FAILURE', clause: CLAUSE } : {}), head: item.item_commit, digest: item.item_frozen_digest,
    note: 'Synthetic solo accept fixture; the check ran red then green on a machine.', ...REVIEW, review: { commit: item.item_commit, head: item.item_commit, trunk: LANDED, paths: [] }, ...solo });
}

const soloEvents = (board, id) => board.db.prepare("SELECT event_by by, event_detail d FROM event WHERE item_id=? AND event_kind='solo-low-stakes-accept'").all(id).map(row => ({ by: row.by, ...JSON.parse(row.d) }));

test('store.io-board-verify.solo-accept-event: clause 1: the builder accepts its own low-stakes work with soloLowStakes, person-approved rows and machine-run red-then-green checks, and one solo-low-stakes-accept event names the verdict, commit, tree, digest and by [C7,#966]', t => {
  const { board } = seeded(t);
  const id = soloItem(board, 'Solo low');
  assert.equal(builderVerify(board, id, 'ACCEPT', { soloLowStakes: true, rows: LOW, checks: MACHINE }).decision, 'ACCEPT');
  const item = store.getItem(board, id);
  assert.equal(item.item_status, 'verified', 'the item is verified through the verified proof trigger');
  const verdict = board.db.prepare('SELECT verdict_id id FROM verdict WHERE item_id=?').get(id).id;
  assert.deepEqual(soloEvents(board, id), [{ by: 'core-1', verdict, commit: item.item_commit, tree: TREE, digest: item.item_frozen_digest }]);
  assert.equal(item.item_verified_by, 'core-1');
});

test('store.io-board-verify.solo-accept-narrow: clause 2: a builder accept without soloLowStakes, with a non-low row or with a check that is not machine-run red-then-green is refused SELF_VERIFY and writes no event; a builder reject is refused [C7,#966]', t => {
  const { board } = seeded(t);
  const refused = (id, decision, solo) => assert.throws(() => builderVerify(board, id, decision, solo), error => error.code === 'SELF_VERIFY');
  const cases = [
    ['Solo flag false', 'low', { soloLowStakes: false, rows: LOW, checks: MACHINE }],
    ['Solo flag absent', 'low', { rows: LOW, checks: MACHINE }],
    ['Solo team row', 'team', { soloLowStakes: true, rows: LOW, checks: MACHINE }],
    ['Solo unproved check', 'low', { soloLowStakes: true, rows: LOW, checks: [{ machineRun: true, redBefore: false, greenAfter: true }] }],
  ];
  for (const [title, stakes, solo] of cases) {
    const id = soloItem(board, title, stakes);
    refused(id, 'ACCEPT', solo);
    assert.equal(store.getItem(board, id).item_status, 'submitted', `${title}: still submitted`);
    assert.equal(soloEvents(board, id).length, 0, `${title}: no event`);
  }
  const rejected = soloItem(board, 'Solo builder reject');
  refused(rejected, 'REJECT', { soloLowStakes: true, rows: LOW, checks: MACHINE });
  assert.equal(soloEvents(board, rejected).length, 0, 'a builder reject writes no event');
});
