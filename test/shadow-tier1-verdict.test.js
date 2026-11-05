/** Tier 1 is recorded beside the independent verdict without changing that verdict [V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tier1ShadowFact } from '../apps/cli/src/shell/tier1-shadow-verdict.js';

test('a passing Tier 1 shadow can differ from the real rejection without changing it [V4]', () => {
  const realVerdict = 'REJECT';
  const fact = tier1ShadowFact([{ event_kind: 'submit', event_detail: JSON.stringify({
    gateGreen: true, commit: 'a'.repeat(40), submissionProof: { files: ['test/unit.test.js'], deferred: true },
  }) }], { state: 'pass' }, realVerdict, 'a'.repeat(40));

  assert.match(fact, /Tier-1 shadow verdict at a{12}: ACCEPT; real reviewer verdict: REJECT/u);
  assert.equal(realVerdict, 'REJECT');
});

test('no Tier 1 fact is emitted without exact green submission and review evidence [V4]', () => {
  const head = 'b'.repeat(40);
  const events = [{ event_kind: 'submit', event_detail: JSON.stringify({ gateGreen: false, commit: head,
    submissionProof: { files: ['test/unit.test.js'], deferred: true } }) }];

  assert.equal(tier1ShadowFact(events, { state: 'pass' }, 'ACCEPT', head), null);
  assert.equal(tier1ShadowFact(events, { state: 'unverified' }, 'REJECT', head), null);
  assert.equal(tier1ShadowFact(events, { state: 'pass' }, 'ACCEPT', 'c'.repeat(40)), null);
});

/** Every gate receipt carries the verdict tier 1 alone would give, as report-only shadow evidence [V4,H16]. */
import * as store from '../packages/store/index.js';
import { recordGateRun } from '../packages/flakes/index.js';
import { receiptFields, tier1Shadow, tier1ShadowFields } from '../packages/verify/index.js';
import { SHADOW_TIER1_ENGINE } from '../src/shadow-tier1-engine.js';
import { fixtureBoard } from './board-fixture.js';

const SHA = 'a'.repeat(40);
const failure = { file: 'test/near.test.js', name: 'near case [V4]' };

/** A native version-two receipt for one item, optionally carrying a shadow fact. */
function receipt(item, digest, seat, { green, failures = [], shadow } = {}) {
  return { version: 2, id: crypto.randomUUID(), kind: 'check', tree: SHA, head: SHA, main: SHA, command: 'b'.repeat(64),
    green, failures, load: null, at: new Date().toISOString(), ...(shadow ? { shadow } : {}),
    proof: { item, frozenDigest: digest, seat, environment: null, runner: null, exitCode: green ? 0 : 1,
      counts: { passed: 0, failed: green ? 0 : 1, skipped: 0 }, durationMs: 5, sourceClean: true } };
}

test('tier 1 judges reachable failures, static or check failures and unreachable failures apart [V4]', () => {
  assert.deepEqual(tier1Shadow({ real: true }).verdict, 'green');
  assert.equal(tier1Shadow({ real: false, failures: [failure], reachable: ['test/near.test.js'] }).verdict, 'red');
  const far = tier1Shadow({ real: false, failures: [failure], reachable: ['test/other.test.js'] });
  assert.equal(far.verdict, 'green');
  assert.equal(far.real, 'red');
  assert.equal(far.differs, true);
  assert.equal(tier1Shadow({ real: false, failures: [], reachable: [] }).verdict, 'red', 'a red run naming no test is a static or check failure');
  assert.equal(tier1Shadow({ real: false, failures: [failure], reachable: null }).verdict, 'red', 'an unknown reach counts every failure');
  const cell = { file: 'test/cells/shape.test.js', name: 'shape [V4]' };
  assert.equal(tier1Shadow({ real: false, failures: [cell], reachable: ['test/cells/shape.test.js'], cellStructure: false }).verdict, 'green');
  assert.equal(tier1Shadow({ real: false, failures: [cell], reachable: [], cellStructure: true }).verdict, 'red');
});

test('a malformed or self-contradicting shadow is refused by the receipt check [V4]', () => {
  const shadow = tier1Shadow({ real: false, failures: [failure], reachable: [] });
  assert.ok(tier1ShadowFields(shadow, false));
  assert.equal(tier1ShadowFields(shadow, true), null, 'it must name the receipt\'s own real verdict');
  assert.equal(tier1ShadowFields({ ...shadow, differs: false }, false), null);
  assert.equal(tier1ShadowFields({ ...shadow, extra: 1 }, false), null);
  assert.equal(receiptFields(receipt(1, null, 'seat', { green: false, failures: [failure], shadow: { ...shadow, verdict: 'red' } })), null);
});

test('a recorded proof keeps the real verdict unchanged when the shadow differs and replays at its own engine [V4,H16]', t => {
  const board = fixtureBoard(t);
  board.executionEngineVersion = SHADOW_TIER1_ENGINE;
  store.register(board, { lane: 'coordinator', path: '/shadow/main' });
  const seat = store.register(board, { lane: 'core', path: '/shadow/seat' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Shadowed', criterion: 'it works [test]', check: 'true' });
  store.claim(board, id, { agentId: seat, lane: 'core', leaseMs: 60 * 60_000, freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'e'.repeat(64) }) });
  const digest = store.getItem(board, id).item_frozen_digest ?? null;
  const shadow = tier1Shadow({ real: false, failures: [failure], reachable: ['test/other.test.js'] });
  assert.equal(shadow.differs, true);
  const run = receiptFields(receipt(id, digest, seat, { green: false, failures: [failure], shadow }));
  assert.ok(run);
  const recorded = store.recordProofRun(board, { agentId: seat, itemId: id, receipt: run, exitFailures: true });
  assert.deepEqual(recorded.shadow, shadow);
  assert.equal(recorded.exitCode, 1, 'the real exit code is as run');
  const stored = store.proofReceipts(board, id).find(row => row.id === run.id);
  assert.deepEqual(stored.shadow, shadow);
  assert.equal(stored.failures.length, 1, 'the real failures are as run');
  const event = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='proof-run' ORDER BY event_id DESC").get();
  assert.equal(JSON.parse(event.event_detail).engine, SHADOW_TIER1_ENGINE);
  const fact = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='fact' AND item_id=? ORDER BY event_id DESC").get(id);
  assert.match(JSON.parse(fact.event_detail).text, /Tier-1 shadow .*: green; real gate result: red; differs: true/u);
  recordGateRun(board, { agentId: seat, receipt: run, lane: 'core' });
  const gate = board.db.prepare("SELECT item_id, event_detail FROM event WHERE event_kind='gate-run' ORDER BY event_id DESC").get();
  assert.equal(gate.item_id, id);
  assert.deepEqual(JSON.parse(gate.event_detail).run.shadow, shadow);
  const gateFact = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='fact' AND item_id=? ORDER BY event_id DESC").get(id);
  assert.match(JSON.parse(gateFact.event_detail).text, /Tier-1 shadow for gate receipt .*: green; real gate result: red; differs: true/u);
});
