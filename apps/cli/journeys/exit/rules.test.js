/** @pullboard-test-loads apps/cli/pullboard.js */
/** Fixture claims exercise real native atomic exit and same-family continuation, never shared sessions [B3,C7,N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { isolateTestMachine } from '../../../../packages/gate/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { boardReceiptStore } from '../../../../packages/gate/index.js';
import { readGateReceipt } from '../../../../packages/gate/index.js';
import { proofRunReceipt } from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import * as store from '../../../../packages/store/index.js';
import { itemById } from '../../../../packages/store/index.js';
import { exitRulesDefaults } from '../../../../packages/config/index.js';
import { exitRulesConfigProblems } from '../../../../packages/config/index.js';
import { nativeToolCallIds } from '../../../../packages/stats/index.js';
import { exitRulesDecision } from '../../../../packages/stats/index.js';
import { exitClaim } from '../../../../packages/store/index.js';
import { exitClaimDecision } from '../../../../packages/store/index.js';
import { exitedSession } from '../../../../packages/store/index.js';
import { requireExitActive } from '../../../../packages/store/index.js';
import { exitContinuationSummary } from '../../../../packages/store/index.js';
import { writeBoardCommand } from '../../../../packages/store/index.js';
import { EXIT_RULES_ENGINE } from '../../../../packages/state/light.js';
import { SHADOW_TIER1_ENGINE } from '../../../../packages/state/light.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { bindRefs } from '../../../../packages/outbox/index.js';
import { resolveMove } from '../../../../packages/outbox/index.js';
import { strayItemRefs } from '../../../../packages/outbox/index.js';
import { minimumMoveEngine } from '../../../../packages/moves/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const policy = { enabled: true, tokens: 100, calls: 3 };
const summary = 'Done: preserved the candidate and native logs; Failed: named fixture case; Next: inspect the retained failure from a fresh session';

/** Actual production SQLite schema, declared synthetic native sessions and ordinary claim APIs. */
function setup(t, enabled = true, claimKey = randomUUID(), padding = 0) {
  const board = fixtureBoard(t);
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: '/exit-fixture/main', session: 'fixture-coordinator', model: 'Fixture coordinator' });
  for (const [id, family, session] of [['core-1', 'openai', 'first'], ['core-2', 'openai', 'fresh'],
    ['core-3', 'claude', 'other'], ['core-4', 'openai', 'first']]) {
    store.register(board, { id, lane: 'core', path: `/exit-fixture/${id}`, family, session: `fixture-${session}`, model: 'Fixture model' });
  }
  for (let n = 0; n < padding; n++) store.shout(board, { from: 'coordinator', to: 'all', text: 'Private extra replica history.', kind: 'idea' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Private exit-rule claim', criterion: 'Retain evidence and hand off.' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
    freeze: () => ({ text: '{}', digest: 'private-exit-bar' }), ...(enabled ? { exitRules: policy, exitClaimKey: claimKey } : {}) });
  return { board, id, claim: exitClaim(board, id, 'core-1') };
}

/** These rows are explicit synthetic native receipt observations for state-machine fixtures, not execution evidence. */
function proof(board, item, id, failure = { file: 'test/private.test.js', name: 'fixture case' }) {
  store.logEvent(board, 'core-1', 'proof-run', item, { receipt: { id, seat: 'core-1', item,
    exitCode: failure ? 1 : 0, failures: failure ? [failure] : [] } });
}

test('default-off and unknown usage never stop, while native tool calls deduplicate stream IDs [B3,C7,N2]', () => {
  assert.deepEqual(exitRulesDefaults(), { enabled: false, tokens: 150000000, calls: 2000 });
  assert.equal(exitRulesConfigProblems({ ...policy, calls: 0 }).length, 1);
  assert.equal(exitRulesDecision(exitRulesDefaults(), { tokens: 999999999, calls: 9999 }), null);
  assert.equal(exitRulesDecision(policy, { tokens: null, calls: null }), null);
  const codex = Buffer.from([1, 1, 2].map(id => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: `call-${id}` } })).join('\n'));
  assert.deepEqual(nativeToolCallIds('codex', codex), ['call-1', 'call-2']);
  const claude = Buffer.from([1, 1, 2].map(id => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `call-${id}` }] } })).join('\n'));
  assert.deepEqual(nativeToolCallIds('claude', claude), ['call-1', 'call-2']);
  assert.equal(nativeToolCallIds('codex', Buffer.from('{broken')), null);
  assert.equal(nativeToolCallIds('codex', Buffer.from('')), null);
});

test('budget exit atomically records summary and release then offers only a fresh same-family session [B3,C7,N2]', t => {
  const f = setup(t);
  store.recordExitProgress(f.board, { agentId: 'core-1', item: f.id, claim: f.claim.key, tokens: 100, calls: 1 });
  assert.throws(() => writeBoardCommand(f.board, 'shout', [{ from: 'core-1', to: 'all', text: 'Private post-budget write.' }], 'core-1'), error => error.code === 'EXIT_BUDGET');
  assert.throws(() => store.release(f.board, f.id, 'core-1', 'not a complete summary', 'BUDGET'), error => error.code === 'EXIT_SUMMARY');
  assert.equal(itemById(f.board, f.id).item_status, 'claimed', 'failed summary rolls back the release');
  assert.equal(exitedSession(f.board, 'core-1'), null);
  store.release(f.board, f.id, 'core-1', summary, 'BUDGET');
  const released = store.events(f.board).filter(row => row.event_kind === 'release' && row.item_id === f.id).at(-1);
  assert.equal(JSON.parse(released.event_detail).reasonCode, 'BUDGET');
  assert.equal(JSON.parse(released.event_detail).exitHandoff.summary, summary);
  assert.equal(itemById(f.board, f.id).item_status, 'open');
  assert.equal(exitContinuationSummary(f.board, f.id), summary);
  assert.equal(store.itemThread(f.board, f.id).filter(row => row.type === 'fact' && row.text === summary).length, 1);
  for (const actor of ['core-1', 'core-3', 'core-4']) assert.throws(() => store.claim(f.board, f.id, { agentId: actor, lane: 'core', leaseMs: 60000,
    freeze: () => ({ text: '{}', digest: 'new' }) }), error => error.code === 'REOPEN_HELD_FOR_BUILDER');
  heartbeatSeat(f.board, 'core-2');
  const offered = store.nextFor(f.board, { agentId: 'core-2', lane: 'core' }).item;
  assert.equal(offered?.item_id, f.id);
  assert.equal(offered.continuationSummary, summary);
  const taken = store.claim(f.board, f.id, { agentId: 'core-2', lane: 'core', leaseMs: 60000,
    freeze: () => ({ text: '{}', digest: 'new' }), exitRules: policy, exitClaimKey: randomUUID() });
  assert.equal(taken.continuationSummary, summary);
  assert.throws(() => requireExitActive(f.board, 'core-4', 'shout'), error => error.code === 'EXIT_BUDGET', 'a renamed seat of the old session cannot continue');
});

test('two consecutive exact native case failures stop, with a green or changed case breaking the repeat [B3,C7,N2]', t => {
  const f = setup(t);
  proof(f.board, f.id, 'first'); proof(f.board, f.id, 'green', null); proof(f.board, f.id, 'second');
  assert.equal(exitClaimDecision(f.board, f.id, 'core-1'), null);
  proof(f.board, f.id, 'different', { file: 'test/other.test.js', name: 'fixture case' });
  assert.equal(exitClaimDecision(f.board, f.id, 'core-1'), null);
  proof(f.board, f.id, 'repeated', { file: 'test/other.test.js', name: 'fixture case' });
  assert.throws(() => requireExitActive(f.board, 'core-1', 'submit'), error => error.code === 'EXIT_REPEAT_FAILURE');
  store.release(f.board, f.id, 'core-1', summary, 'OTHER');
  assert.equal(itemById(f.board, f.id).item_status, 'open');
  assert.equal(exitContinuationSummary(f.board, f.id), summary);
});

test('claim counters reject stale owners and preserve a proven stop across unknown later observations [B3,C7,H16]', t => {
  const f = setup(t);
  assert.throws(() => store.recordExitProgress(f.board, { agentId: 'core-2', item: f.id, claim: f.claim.key, tokens: 100, calls: 0 }), error => error.code === 'NOT_YOURS');
  store.recordExitProgress(f.board, { agentId: 'core-1', item: f.id, claim: f.claim.key, tokens: null, calls: 3 });
  store.recordExitProgress(f.board, { agentId: 'core-1', item: f.id, claim: f.claim.key, tokens: null, calls: null });
  assert.equal(exitClaimDecision(f.board, f.id, 'core-1').code, 'EXIT_BUDGET');
  assert.equal(minimumMoveEngine('recordExitProgress', [{}]), EXIT_RULES_ENGINE);
  f.board.executionEngineVersion = EXIT_RULES_ENGINE - 1;
  assert.throws(() => store.recordExitProgress(f.board, { agentId: 'core-1', item: f.id, claim: f.claim.key, tokens: 100, calls: 3 }), error => error.code === 'ENGINE_VERSION');
});

test('an external native CLI captures the claim prefix, refuses its next command and seals the release summary [B3,C7,N2]', { timeout: 120000 }, t => {
  const helpers = createE2eHelpers(), sandbox = helpers.sandbox({ declareFamilies: true });
  sandbox.env.PULLBOARD_MODEL = 'Test Model';
  isolateTestMachine(sandbox.env, sandbox.dir);
  sandbox.env.CODEX_HOME = join(sandbox.dir, 'private-codex');
  sandbox.env.CODEX_THREAD_ID = 'exit-fixture-native-session';
  delete sandbox.env.CLAUDE_CODE_SESSION_ID;
  const sessions = join(sandbox.env.CODEX_HOME, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const transcript = join(sessions, `fixture-${sandbox.env.CODEX_THREAD_ID}.jsonl`);
  /** Only synthetic provider-shaped records in this test's private source are used as counter evidence. */
  const usage = tokens => ({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: tokens, output_tokens: 0, cached_input_tokens: 0 } } } });
  writeFileSync(transcript, [
    { type: 'session_meta', payload: { id: sandbox.env.CODEX_THREAD_ID } },
    { type: 'turn_context', payload: { model: 'Test Model' } }, usage(0),
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const box = helpers.project('true', sandbox);
  t.after(helpers.cleanup);
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.exitRules = { enabled: true, tokens: 10, calls: 10 };
  writeFileSync(file, JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-qm', 'test: enable private exit policy');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Private native exit', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.out + added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  appendFileSync(transcript, JSON.stringify(usage(10)) + '\n');
  const stopped = box.run(box.web, 'status', '--json');
  assert.equal(stopped.code, 1, stopped.out + stopped.err);
  assert.equal(JSON.parse(stopped.out).error.code, 'EXIT_BUDGET');
  const released = box.run(box.web, 'release', String(id), '--reason', 'BUDGET', '--note', summary, '--no-next', '--json');
  assert.equal(released.code, 0, released.out + released.err);
  const fenced = box.run(box.web, 'status', '--json');
  assert.equal(fenced.code, 1, fenced.out + fenced.err);
  assert.equal(JSON.parse(fenced.out).error.code, 'EXIT_BUDGET');
});

test('out-of-order captures retain independent counter high-water through unknowns without false refusals [B3,C7,N2]', t => {
  const f = setup(t);
  const record = (tokens, calls) => store.recordExitProgress(f.board, {
    agentId: 'core-1', item: f.id, claim: f.claim.key, tokens, calls });
  record(12, 1); // The newer token capture obtains the writer before the older capture below.
  const stale = record(10, 2); // Call and token observations need not arrive in the same order.
  assert.deepEqual(stale, { tokens: 12, calls: 2, highWater: { tokens: 12, calls: 2 } });
  const unknown = record(null, null);
  assert.deepEqual(unknown, { tokens: null, calls: null, highWater: { tokens: 12, calls: 2 } });
  assert.equal(exitClaimDecision(f.board, f.id, 'core-1'), null, 'unknown counters alone never trigger a stop');
  assert.deepEqual(record(9, 1), { tokens: 12, calls: 2, highWater: { tokens: 12, calls: 2 } });
  assert.equal(exitClaimDecision(f.board, f.id, 'core-1'), null);
  assert.throws(() => store.recordExitProgress(f.board, { agentId: 'core-1', item: f.id,
    claim: randomUUID(), tokens: 100, calls: 3 }), error => error.code === 'NOT_YOURS');
  record(100, 2);
  record(null, null);
  record(10, 0);
  assert.equal(exitClaimDecision(f.board, f.id, 'core-1').code, 'EXIT_BUDGET', 'known stop cannot be erased by unknown or late captures');
});

test('immutable claim keys survive different replica history and nested item remapping [B3,C7,H16]', t => {
  const key = randomUUID(), origin = setup(t, true, key), replica = setup(t, true, key, 2);
  assert.notEqual(origin.claim.id, replica.claim.id, 'the real private boards have different local event sequences');
  assert.equal(origin.claim.key, replica.claim.key);
  const request = { agentId: 'core-1', item: origin.id, claim: key, tokens: 100, calls: 1 };
  const move = prepareEngineMove(origin.board, 'recordExitProgress', [request], { actor: 'core-1' });
  const outcome = applyEngineMove(replica.board, move, { sequence: 1, at: new Date().toISOString() });
  assert.equal(outcome.error, undefined, JSON.stringify(outcome));
  assert.equal(exitClaimDecision(replica.board, replica.id, 'core-1').code, 'EXIT_BUDGET');
  assert.equal(exitClaimDecision(replica.board, replica.id, 'core-1').claim, key);
  const outbox = { moves: [{ move: { id: 'private-add', operation: 'addItem', args: [{ by: 'coordinator', lane: 'core', title: 'Private provisional item' }] }, visible: origin.id }], results: { 'private-add': origin.id + 10 } };
  const queued = { move, refs: bindRefs(outbox, move) };
  assert.deepEqual(strayItemRefs(outbox, move), []);
  const remapped = resolveMove(queued, outbox).move;
  assert.equal(remapped.args[0].item, origin.id + 10);
  assert.equal(remapped.args[0].claim, key, 'the native opaque claim identity is never mistaken for a local item number');
});


test('ordinary native failed checks retain cases through receipt recording and stop the repeated claim [B3,C7,H16]', { timeout: 120000 }, t => {
  const helpers = createE2eHelpers(), sandbox = helpers.sandbox({ declareFamilies: true });
  sandbox.env.PULLBOARD_MODEL = 'Test Model';
  isolateTestMachine(sandbox.env, sandbox.dir);
  const check = 'node --test web/private-exit-repeat.test.cjs';
  const box = helpers.project('true', sandbox);
  t.after(helpers.cleanup);
  delete box.env.NODE_TEST_CONTEXT; // This child launches its own real Node test worker.
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.exitRules = { enabled: true, tokens: 150000000, calls: 2000 };
  writeFileSync(configPath, JSON.stringify(config));
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/private-exit-repeat.test.cjs'),
    "require('node:test')('private repeated native failure [G1]', () => { require('node:assert/strict').equal(1, 2); });\n");
  box.git(box.repo, 'add', 'pullboard.json', 'web/private-exit-repeat.test.cjs');
  box.git(box.repo, 'commit', '-qm', 'test: enable private repeated native proof');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Private repeated native proof', '--specs', 'G1', '--check', check, '--route', 'strong', '--json');
  assert.equal(added.code, 0, added.out + added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  for (let n = 0; n < 2; n++) {
    const red = box.run(box.web, 'check', String(id), '--yes', '--json');
    assert.equal(red.code, 1, red.out + red.err);
    assert.equal(JSON.parse(red.out).green, false, 'the real private process failed, rather than an admission refusal');
    if (!n) {
      const active = box.run(box.web, 'status', '--json');
      assert.equal(active.code, 0, active.out + active.err);
    }
  }
  // @pullboard-board-file journey: real CLI checks persist native receipts consumed by the claim stop and replay.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  t.after(() => store.closeBoard(board));
  const receipts = store.proofReceipts(board, id);
  assert.equal(receipts.length, 2);
  for (const receipt of receipts) {
    assert.equal(Object.hasOwn(receipt, 'blockingVerdict'), false, 'no quarantine manufactures the failure projection');
    assert.deepEqual(receipt.failures, [{ file: 'web/private-exit-repeat.test.cjs', name: 'private repeated native failure [G1]' }]);
    const raw = readGateReceipt(boardReceiptStore(board), receipt.id);
    assert.deepEqual(raw.failures, receipt.failures, 'the case identity comes from the actual native writer');
    const move = prepareEngineMove(board, 'recordProofRun', [{ agentId: receipt.seat, itemId: id, receiptId: receipt.id }], { actor: receipt.seat });
    assert.equal(move.args[0].exitFailures, true);
    assert.equal(minimumMoveEngine(move.operation, move.args), Object.hasOwn(move.args[0].receipt ?? {}, 'shadow') ? SHADOW_TIER1_ENGINE : EXIT_RULES_ENGINE, 'the exit floor, or the shadow floor when the native receipt carries shadow proof');
    assert.deepEqual(proofRunReceipt(board, { agentId: receipt.seat, itemId: id, receiptId: receipt.id }).receipt.failures, raw.failures);
  }
  const historical = fixtureBoard(t);
  store.register(historical, { id: 'coordinator', lane: 'coordinator', path: '/exit-receipt-history/main' });
  store.register(historical, { id: receipts[0].seat, lane: 'web', path: '/exit-receipt-history/web' });
  const oldItem = store.addItem(historical, { by: 'coordinator', lane: 'web', title: 'Private historical receipt' });
  assert.equal(oldItem, id);
  store.claim(historical, oldItem, { agentId: receipts[0].seat, lane: 'web', leaseMs: 60000,
    freeze: () => ({ text: '{}', digest: receipts[0].frozenDigest }) });
  historical.executionEngineVersion = EXIT_RULES_ENGINE - 1;
  const oldRequest = { agentId: receipts[0].seat, itemId: oldItem,
    receipt: readGateReceipt(boardReceiptStore(board), receipts[0].id) };
  const old = store.recordProofRun(historical, oldRequest);
  assert.equal(Object.hasOwn(old, 'failures'), false, 'historical replay keeps the old receipt shape');
  const { eventId, ...replayedOld } = store.recordProofRun(historical, oldRequest);
  assert.ok(Number.isSafeInteger(eventId));
  assert.deepEqual(replayedOld, old, 'historical receipt replay preserves every original field');
  assert.equal(store.proofReceipts(historical, oldItem).length, 1, 'duplicate recording never publishes a second proof');
  const oldEvent = historical.db.prepare("SELECT event_detail FROM event WHERE event_kind='proof-run' AND item_id=?").get(oldItem);
  assert.ok(JSON.parse(oldEvent.event_detail).engine < EXIT_RULES_ENGINE, 'historical receipt events keep their original floor');
  assert.equal(exitClaimDecision(board, id, receipts[0].seat).code, 'EXIT_REPEAT_FAILURE');
  const stopped = box.run(box.web, 'status', '--json');
  assert.equal(stopped.code, 1, stopped.out + stopped.err);
  assert.equal(JSON.parse(stopped.out).error.code, 'EXIT_REPEAT_FAILURE');
});
