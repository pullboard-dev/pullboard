/** @pullboard-test-input source-tree */
/** @pullboard-test-loads bin/pullboard.js */
/** Fixture claims exercise real native atomic exit and same-family continuation, never shared sessions [B3,C7,N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e-helpers.js';
import { isolateTestMachine } from '../src/test-isolation.js';
import { heartbeatSeat } from '../src/seat-presence.js';
import { fixtureBoard } from './board-fixture.js';
import * as store from '../src/board.js';
import { itemById } from '../src/board-item-read.js';
import { exitRulesDefaults, exitRulesConfigProblems } from '../src/exit-rules-config.js';
import { nativeToolCallIds } from '../src/exit-rules-calls.js';
import { exitRulesDecision } from '../src/exit-rules-policy.js';
import { exitClaim, exitClaimDecision, exitedSession, requireExitActive, exitContinuationSummary } from '../src/exit-rules-state.js';
import { writeBoardCommand } from '../src/board-command-write.js';
import { EXIT_RULES_ENGINE } from '../src/exit-rules-engine.js';
import { minimumMoveEngine } from '../src/move-registry.js';

const policy = { enabled: true, tokens: 100, calls: 3 };
const summary = 'Done: preserved the candidate and native logs; Failed: named fixture case; Next: inspect the retained failure from a fresh session';

/** Actual production SQLite schema, declared synthetic native sessions and ordinary claim APIs. */
function setup(t, enabled = true) {
  const board = fixtureBoard(t);
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: '/exit-fixture/main', session: 'fixture-coordinator', model: 'Fixture coordinator' });
  for (const [id, family, session] of [['core-1', 'openai', 'first'], ['core-2', 'openai', 'fresh'],
    ['core-3', 'claude', 'other'], ['core-4', 'openai', 'first']]) {
    store.register(board, { id, lane: 'core', path: `/exit-fixture/${id}`, family, session: `fixture-${session}`, model: 'Fixture model' });
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Private exit-rule claim', criterion: 'Retain evidence and hand off.' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
    freeze: () => ({ text: '{}', digest: 'private-exit-bar' }), ...(enabled ? { exitRules: policy } : {}) });
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
  store.recordExitProgress(f.board, { agentId: 'core-1', item: f.id, claim: f.claim.id, tokens: 100, calls: 1 });
  assert.throws(() => writeBoardCommand(f.board, 'shout', [{ from: 'core-1', to: 'all', text: 'Private post-budget write.' }], 'core-1'), error => error.code === 'EXIT_BUDGET');
  assert.throws(() => store.release(f.board, f.id, 'core-1', 'not a complete summary'), error => error.code === 'EXIT_SUMMARY');
  assert.equal(itemById(f.board, f.id).item_status, 'claimed', 'failed summary rolls back the release');
  assert.equal(exitedSession(f.board, 'core-1'), null);
  store.release(f.board, f.id, 'core-1', summary);
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
    freeze: () => ({ text: '{}', digest: 'new' }), exitRules: policy });
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
  store.release(f.board, f.id, 'core-1', summary);
  assert.equal(itemById(f.board, f.id).item_status, 'open');
  assert.equal(exitContinuationSummary(f.board, f.id), summary);
});

test('claim counters reject stale owners and preserve a proven stop across unknown later observations [B3,C7,H16]', t => {
  const f = setup(t);
  assert.throws(() => store.recordExitProgress(f.board, { agentId: 'core-2', item: f.id, claim: f.claim.id, tokens: 100, calls: 0 }), error => error.code === 'NOT_YOURS');
  store.recordExitProgress(f.board, { agentId: 'core-1', item: f.id, claim: f.claim.id, tokens: null, calls: 3 });
  store.recordExitProgress(f.board, { agentId: 'core-1', item: f.id, claim: f.claim.id, tokens: null, calls: null });
  assert.equal(exitClaimDecision(f.board, f.id, 'core-1').code, 'EXIT_BUDGET');
  assert.equal(minimumMoveEngine('recordExitProgress', [{}]), EXIT_RULES_ENGINE);
  f.board.executionEngineVersion = EXIT_RULES_ENGINE - 1;
  assert.throws(() => store.recordExitProgress(f.board, { agentId: 'core-1', item: f.id, claim: f.claim.id, tokens: 100, calls: 3 }), error => error.code === 'ENGINE_VERSION');
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
  const added = box.run(box.repo, 'add', 'web', 'Private native exit', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.out + added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  appendFileSync(transcript, JSON.stringify(usage(10)) + '\n');
  const stopped = box.run(box.web, 'status', '--json');
  assert.equal(stopped.code, 1, stopped.out + stopped.err);
  assert.equal(JSON.parse(stopped.out).error.code, 'EXIT_BUDGET');
  const released = box.run(box.web, 'release', String(id), '--note', summary, '--no-next', '--json');
  assert.equal(released.code, 0, released.out + released.err);
  const fenced = box.run(box.web, 'status', '--json');
  assert.equal(fenced.code, 1, fenced.out + fenced.err);
  assert.equal(JSON.parse(fenced.out).error.code, 'EXIT_BUDGET');
});
