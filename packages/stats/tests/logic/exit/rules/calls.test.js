/** A seat's session ends at a context ceiling across claims, so the next item starts fresh [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exitRulesConfigProblems } from '../../../../../config/index.js';
import { contextCeiling } from '../../../../index.js';
import { exitContextDecision } from '../../../../index.js';
import { nativeLastPrompt } from '../../../../index.js';

const CODEX_MODEL = 'gpt-6';
const policy = { enabled: true, tokens: 150_000_000, calls: 2000 };

/** A Claude-shaped native log whose assistant calls carry the given usage rows. */
function claudeLog(model, ...prompts) {
  return Buffer.from(prompts.map(([input, read, write]) => JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write }, content: [] } })).join('\n') + '\n');
}

test('stats.calls.a-seat-whose-last-call-prompt: clause 1: a seat whose last call prompt exceeds the ceiling ends after its claim settles, counted across claims [C7]', () => {
  // Two claims in one session: the first call was small, the newest prompt (input + cached reads + cache writes) is over 200000.
  const last = nativeLastPrompt('claude', claudeLog('claude-sonnet-5-5', [100, 1000, 0], [500, 190_000, 10_000]));
  assert.deepEqual(last, { tokens: 200_500, model: 'claude-sonnet-5-5' });
  const decision = exitContextDecision(policy, last);
  assert.equal(decision.code, 'EXIT_CONTEXT');
  assert.equal(decision.ceiling, 200_000);
  assert.equal(exitContextDecision(policy, nativeLastPrompt('claude', claudeLog('claude-sonnet-5-5', [500, 190_000, 9_000]))), null, 'under the ceiling keeps the session');
  assert.equal(exitContextDecision(policy, { tokens: 200_000, model: 'claude-sonnet-5-5' }), null, 'a prompt exactly at the ceiling keeps the session');
  assert.equal(exitContextDecision(policy, { tokens: 200_001, model: 'claude-sonnet-5-5' }).code, 'EXIT_CONTEXT');
  const codex = Buffer.from([{ type: 'turn_context', payload: { model: CODEX_MODEL } }, { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 250_000 } } } }].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal(exitContextDecision(policy, nativeLastPrompt('codex', codex)).context, 250_000);
});

test('stats.calls.contextceiling-defaults-to-100000-for-haiku: clause 2: contextCeiling defaults to 100000 for Haiku and 200000 otherwise, is settable, and unknown usage never ends a session [C7]', () => {
  assert.equal(contextCeiling(policy, 'claude-haiku-5-5'), 100_000);
  assert.equal(contextCeiling(policy, 'claude-sonnet-5-5'), 200_000);
  assert.equal(contextCeiling({ ...policy, contextCeiling: 50_000 }, 'claude-sonnet-5-5'), 50_000);
  assert.deepEqual(exitRulesConfigProblems({ ...policy, contextCeiling: 50_000 }), []);
  assert.equal(exitRulesConfigProblems({ ...policy, contextCeiling: 0 }).length, 1);
  assert.equal(exitContextDecision(policy, null), null);
  assert.equal(exitContextDecision(policy, nativeLastPrompt('claude', Buffer.from('{"type":"assistant","message":{"content":[]}}\n'))), null);
  assert.equal(exitContextDecision(policy, nativeLastPrompt('claude', Buffer.from('not json\n'))), null);
  assert.equal(exitContextDecision({ ...policy, enabled: false }, { tokens: 9e9, model: 'x' }), null);
});
