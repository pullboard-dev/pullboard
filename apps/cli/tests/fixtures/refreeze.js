/** Real Git and SQLite fixtures for spec-row corrections that invalidate unmerged cited items [V2,H16]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  COORDINATOR,
  loadConfig,
} from '../../../../packages/config/index.js';
import { AUTOMATIC_DISPATCH_ENGINE } from '../../../../packages/state/light.js';
import {
  applyRelayMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { loadDoctrine } from '../../../../packages/doctrine/index.js';
import {
  planRowApply,
  prepareRowDecisions,
  writeRowApply,
} from '../../../../packages/spec/index.js';
import { rowDecisions } from '../../../../packages/spec/index.js';
import { freezer } from '../../index.js';
import { prepareSpecRefreezes } from '../../../../packages/spec/index.js';
import { createE2eHelpers } from './e2e.js';
import { submitFixture } from './board/submit.js';

/** Assert that applying a person-approved spec correction refreezes every unmerged citation [V2,H16]. */
export function assertSpecCorrectionRefreezesCitations(t) {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  t.after(() => {
    store.closeBoard(board);
    helpers.cleanup();
  });

  /** Add a real board item with an optional spec citation. */
  const add = (title, specIds = ['G1']) => store.addItem(board, {
    by: COORDINATOR, lane: 'web', title, criterion: `Deliver ${title.toLowerCase()}.`,
    check: 'true', specIds, brief: 'Files: web/refreeze.js\nTest: the cited criterion is checked.',
  });
  /** Claim through the CLI so the frozen bytes come from the fixture's actual SPEC.md. */
  const claim = (id) => {
    const result = box.run(box.web, 'claim', String(id), '--json');
    assert.equal(result.code, 0, result.err || result.out);
    return store.getItem(board, id);
  };
  /** Record a synthetic submission through the real board transition, without claiming a gate ran. */
  const submit = (id) => {
    const item = store.getItem(board, id);
    const commit = box.git(box.web, 'rev-parse', 'HEAD');
    const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
    submitFixture(board, id, { agentId: item.item_owner, commit, tree });
  };

  const openId = add('Open citation');
  const claimedId = add('Live claim citation');
  const submittedId = add('Submitted citation');
  const verifiedId = add('Verified citation');
  const unrelatedId = add('Unrelated row', ['G2']);
  const withdrawnId = add('Withdrawn citation');

  claim(submittedId);
  submit(submittedId);
  claim(verifiedId);
  submit(verifiedId);
  const verified = store.getItem(board, verifiedId);
  store.verify(board, verifiedId, {
    agentId: COORDINATOR, decision: 'ACCEPT', reason: store.ACCEPT_REASON,
    note: 'fixture acceptance before spec correction',
    head: verified.item_commit, digest: verified.item_frozen_digest, policy: 'any',
  });
  claim(claimedId);
  const beforeClaimed = store.getItem(board, claimedId);
  const oldClaimedBar = beforeClaimed.item_frozen_digest;
  const oldVerifiedVerdicts = store.verdictsFor(board, verifiedId);
  assert.equal(beforeClaimed.item_status, 'claimed');
  assert.equal(store.getItem(board, submittedId).item_status, 'submitted');
  assert.equal(store.getItem(board, verifiedId).item_status, 'verified');

  store.withdraw(board, withdrawnId, { agentId: COORDINATOR, reason: 'fixture excludes withdrawn citations' });
  const config = loadConfig(box.repo);
  const decision = prepareRowDecisions(box.repo, config, {
    ids: ['G1'], decision: 'approve', text: 'The revised page renders.', by: 'person',
    on: new Date().toISOString(), commit: box.git(box.repo, 'rev-parse', 'HEAD'),
  }, { loadDoctrine });
  store.recordRowDecisions(board, { agentId: store.PERSON, channel: 'terminal', decisions: decision });

  const applied = box.run(box.repo, 'spec', 'apply', '--json');
  assert.equal(applied.code, 0, applied.err || applied.out);
  const repeated = box.run(box.repo, 'spec', 'apply', '--json');
  assert.equal(repeated.code, 0, repeated.err || repeated.out);
  assert.deepEqual(JSON.parse(repeated.out).applied, [], 'an already applied decision remains a no-op');

  const correctedText = 'The revised page renders.';
  for (const id of [openId, claimedId, submittedId, verifiedId]) {
    const item = store.getItem(board, id);
    assert.ok(item.item_frozen, `citing item #${id} has a complete frozen payload`);
    assert.ok(item.item_frozen_digest, `citing item #${id} has its frozen digest`);
    assert.match(item.item_frozen, /The revised page renders\./u, `citing item #${id} freezes corrected row text`);
    assert.equal(item.item_spec_ids, 'G1');
  }
  assert.notEqual(store.getItem(board, claimedId).item_frozen_digest, oldClaimedBar,
    'a live claim adopts the corrected bar atomically');
  const claimedAfter = store.getItem(board, claimedId);
  assert.equal(claimedAfter.item_status, 'claimed');
  assert.equal(claimedAfter.item_owner, beforeClaimed.item_owner, 'the live holder remains assigned');
  assert.equal(claimedAfter.item_lease_until, beforeClaimed.item_lease_until, 'the live lease is retained');
  assert.ok(store.inbox(board, beforeClaimed.item_owner).some(entry =>
    entry.shout_text.includes(`corrected #${claimedId}`)), 'the retained holder is notified in the same apply');

  assert.equal(store.getItem(board, submittedId).item_status, 'open', 'a submission at the stale bar returns to open');
  const verifiedAfter = store.getItem(board, verifiedId);
  assert.equal(verifiedAfter.item_status, 'open', 'a stale unmerged acceptance returns to open');
  assert.equal(verifiedAfter.item_verdict, null, 'stale acceptance fields are cleared from the live item');
  assert.ok(store.verdictsFor(board, verifiedId).some(verdict => verdict.verdict_decision === 'ACCEPT'),
    'the immutable acceptance audit remains available');
  assert.deepEqual(store.getItem(board, unrelatedId).item_frozen, null, 'a nonciting item is unchanged');
  assert.equal(store.getItem(board, withdrawnId).item_status, 'withdrawn', 'withdrawn citations are excluded');
  assert.equal(store.getItem(board, withdrawnId).item_frozen, null);
  assert.equal(correctedText, 'The revised page renders.');
}

/** Build a typed apply move from a real pending decision and its already-written replacement file.
 * @param {any} box - The isolated repository and board fixture.
 * @param {any} board - The local board whose pending decision is sealed into the move.
 * @param {string} id - Stable move identity for this fixture control.
 * @returns {any} A serialized engine move with complete frozen payloads.
 */
function correctionMove(box, board, id) {
  const config = loadConfig(box.root);
  const records = rowDecisions(board);
  const plan = planRowApply(box.root, config, records, undefined, { loadDoctrine });
  writeRowApply(box.root, plan);
  const ctx = { info: { root: box.root, isMain: true }, config, doctrine: loadDoctrine(box.root, config), clock: box.clock };
  const refreezes = prepareSpecRefreezes(plan.records, store.listItems(board, { all: true }),
    freezer(ctx, { captureVerifyPolicy: true, board, applyingDecisions: plan.records }));
  assert.ok(refreezes !== undefined, 'an approved changed row carries the new protocol marker');
  const args = { agentId: COORDINATOR, events: plan.records.map(record => record.event), refreezes };
  return prepareEngineMove(board, 'applyRowDecisions', [args], { id, actor: COORDINATOR });
}

/** Compare domain state around a replay refusal, allowing its normal refusal receipt to advance the prefix.
 * @param {any} board - The receiver board.
 * @param {any} move - The move expected to be refused.
 * @param {any} order - Its authenticated relay position.
 * @param {string} code - Expected refusal code.
 */
function assertNoDomainApply(board, move, order, code) {
  const items = store.listItems(board, { all: true });
  const decisions = rowDecisions(board);
  const result = applyRelayMove(board, move, order);
  assert.equal(result.error?.code, code, JSON.stringify(result));
  assert.deepEqual(store.listItems(board, { all: true }), items, 'a refused replay changes no item state');
  assert.deepEqual(rowDecisions(board), decisions, 'a refused replay applies no person decisions');
}

/** Replay typed spec-apply moves across imported SQLite prefixes and exercise stale/refusal boundaries [V2,H16].
 * @param {import('node:test').TestContext} t - Owns fixture cleanup.
 * @param {{ fixture: (t: import('node:test').TestContext) => Promise<any> }} options - Real repository fixture factory.
 * @returns {Promise<void>}
 */
export async function assertSpecRefreezeReplay(t, { fixture, cli }) {
  const box = await fixture(t);
  writeFileSync(join(box.root, 'SPEC.md'), readFileSync(join(box.root, 'SPEC.md'), 'utf8')
    + '- G2 [approved, must] Unrelated work keeps its evidence. | gate: true\n');
  box.git(box.root, 'add', 'SPEC.md');
  box.git(box.root, 'commit', '-q', '-m', 'test: add independent replay spec row [G1,G2]');
  const id = box.add('Replayed spec correction');
  const nonCitingId = box.add('Only cites G2', { specIds: ['G2'] });
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(id)]);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const decision = prepareRowDecisions(box.root, box.config, {
    ids: ['G1'], decision: 'approve', text: 'The replayed page renders.', by: 'person',
    on: box.clock.now().toISOString(), commit: box.git(box.root, 'rev-parse', 'HEAD'),
  }, { loadDoctrine });
  store.recordRowDecisions(box.board, { agentId: store.PERSON, channel: 'terminal', decisions: decision });

  const move = correctionMove(box, box.board, 'spec-refreeze-replay-valid');
  const prefix = exportBoard(box.board);
  const replica = openBoard(':memory:', box.clock);
  t.after(() => store.closeBoard(replica));
  importBoard(replica, prefix);
  assert.deepEqual(exportBoard(replica), prefix, 'the receiver starts from the exact imported decision/item prefix');

  const order = { sequence: 1, at: box.clock.now().toISOString(), kind: 'move',
    sender: { kind: 'agent', userId: 'fixture-user', agent: COORDINATOR } };
  const local = applyRelayMove(box.board, move, order);
  const replayed = applyRelayMove(replica, move, order);
  assert.equal(local.error, undefined, JSON.stringify(local));
  assert.deepEqual(replayed, local, 'the receiver applies the exact sealed spec-apply move');
  assert.deepEqual(exportBoard(replica), exportBoard(box.board), 'items, decisions, notices and receipts match after replay');
  const applied = exportBoard(replica);
  assert.deepEqual(applyRelayMove(replica, move, order), replayed, 'a duplicate returns the same apply receipt');
  assert.deepEqual(exportBoard(replica), applied, 'duplicate replay does not refreeze or notify twice');

  const omittedMarker = openBoard(':memory:', box.clock);
  t.after(() => store.closeBoard(omittedMarker));
  importBoard(omittedMarker, prefix);
  const omitted = structuredClone(move);
  delete omitted.args[0].refreezes;
  assertNoDomainApply(omittedMarker, omitted, order, 'ROW_DECISION');

  const legacy = openBoard(':memory:', box.clock);
  t.after(() => store.closeBoard(legacy));
  importBoard(legacy, prefix);
  const historical = structuredClone(omitted);
  historical.engine = AUTOMATIC_DISPATCH_ENGINE - 1;
  const legacyItem = store.getItem(legacy, id);
  const historicalResult = applyRelayMove(legacy, historical, order);
  assert.equal(historicalResult.error, undefined, 'historical marker-free decisions retain their recorded apply behavior');
  assert.deepEqual(store.getItem(legacy, id), legacyItem, 'old-engine replay does not invent new refreeze semantics');

  const newCitation = openBoard(':memory:', box.clock);
  t.after(() => store.closeBoard(newCitation));
  importBoard(newCitation, prefix);
  store.addItem(newCitation, { by: COORDINATOR, lane: 'web', title: 'Late G1 citation',
    criterion: 'The late item uses G1.', check: 'true', specIds: ['G1'],
    brief: 'Files: web/late.js\nTest: the late item cites G1.' });
  assertNoDomainApply(newCitation, structuredClone(move), order, 'STALE_ROW_DECISION');

  const staleSnapshot = openBoard(':memory:', box.clock);
  t.after(() => store.closeBoard(staleSnapshot));
  importBoard(staleSnapshot, prefix);
  const staleBefore = structuredClone(move);
  staleBefore.args[0].refreezes[0].before.status = 'submitted';
  assertNoDomainApply(staleSnapshot, staleBefore, order, 'STALE_ROW_DECISION');

  const badHash = openBoard(':memory:', box.clock);
  t.after(() => store.closeBoard(badHash));
  importBoard(badHash, prefix);
  const tamperedHash = structuredClone(move);
  tamperedHash.args[0].refreezes[0].frozen.digest = '0'.repeat(64);
  assertNoDomainApply(badHash, tamperedHash, order, 'ROW_DECISION');

  const nullPayload = openBoard(':memory:', box.clock);
  t.after(() => store.closeBoard(nullPayload));
  importBoard(nullPayload, prefix);
  const malformed = structuredClone(move);
  malformed.args[0].refreezes = null;
  const beforeMalformed = exportBoard(nullPayload);
  assert.throws(() => applyRelayMove(nullPayload, malformed, order), error => error.code === 'ROW_DECISION');
  assert.deepEqual(exportBoard(nullPayload), beforeMalformed, 'a null marker is rejected before any receipt or domain write');

  const oldEngine = openBoard(':memory:', box.clock);
  t.after(() => store.closeBoard(oldEngine));
  importBoard(oldEngine, prefix);
  const belowFloor = structuredClone(move);
  belowFloor.engine = AUTOMATIC_DISPATCH_ENGINE - 1;
  const beforeOld = exportBoard(oldEngine);
  assert.throws(() => applyRelayMove(oldEngine, belowFloor, order), error => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(oldEngine), beforeOld, 'an older engine cannot apply or advance this marker');

  store.withdraw(box.board, nonCitingId, { agentId: COORDINATOR, reason: 'fixture removes the only G2 citation' });
  const emptyDecision = prepareRowDecisions(box.root, box.config, {
    ids: ['G2'], decision: 'approve', text: 'An approved row with no citations.', by: 'person',
    on: box.clock.now().toISOString(), commit: box.git(box.root, 'rev-parse', 'HEAD'),
  }, { loadDoctrine });
  store.recordRowDecisions(box.board, { agentId: store.PERSON, channel: 'terminal', decisions: emptyDecision });
  const emptyMove = correctionMove(box, box.board, 'spec-refreeze-replay-empty');
  assert.deepEqual(emptyMove.args[0].refreezes, [], 'a changed approved row with zero cited items still carries the protocol marker');
  const emptyPrefix = exportBoard(box.board);
  const emptyReplica = openBoard(':memory:', box.clock);
  t.after(() => store.closeBoard(emptyReplica));
  importBoard(emptyReplica, emptyPrefix);
  const emptyOrder = { ...order, sequence: 2, at: box.clock.now().toISOString() };
  const emptyLocal = applyRelayMove(box.board, emptyMove, emptyOrder);
  const emptyResult = applyRelayMove(emptyReplica, emptyMove, emptyOrder);
  assert.equal(emptyLocal.error, undefined, JSON.stringify(emptyLocal));
  assert.equal(emptyResult.error, undefined, JSON.stringify(emptyResult));
  assert.deepEqual(emptyResult, emptyLocal, 'the empty-marker move replays without a local citation');
  assert.deepEqual(exportBoard(emptyReplica), exportBoard(box.board));
  assert.equal(rowDecisions(emptyReplica).find(record => record.event === emptyMove.args[0].events[0]).applied, true,
    'the empty refreeze marker still applies the approved decision');
  assert.equal(store.getItem(emptyReplica, nonCitingId).item_spec_ids, 'G2', 'the non-citing item remains unchanged');
  assert.equal(store.getItem(emptyReplica, nonCitingId).item_status, 'withdrawn');
}
