/** Native session fixtures keep supported provider totals exact and missing sources visibly unknown [N2]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nativeUsage } from '../../src/io/cost/provider.js';
import { usageCheckpoint } from '../../src/io/cost/ledger.js';

/** Serialize fixture rows into the same JSONL boundary used by native provider logs. */
function jsonl(rows) {
  return Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

test('stats.activity.claude-session-tokens-retain-fresh-cached: Claude session tokens retain fresh, cached-read, cached-write and output counts [N2]', () => {
  const [usage] = nativeUsage({ provider: 'claude', file: 'fixture.jsonl' }, jsonl([
    { type: 'assistant', timestamp: '2026-11-05T12:00:00.000Z', message: {
      id: 'message-1', model: 'fixture-sonnet', usage: {
        input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5,
      },
    } },
  ]));

  assert.deepEqual(usage, {
    at: Date.parse('2026-11-05T12:00:00.000Z'), model: 'fixture-sonnet', inputTokens: 125, outputTokens: 10,
    freshInputTokens: 100, cacheReadInputTokens: 20, cacheWriteInputTokens: 5,
  });
});

test('stats.activity.codex-session-tokens-retain-fresh-cached: Codex session tokens retain fresh, cached-read and output counts [N2]', () => {
  const [usage] = nativeUsage({ provider: 'codex', file: 'fixture.jsonl' }, jsonl([
    { type: 'turn_context', timestamp: '2026-11-05T12:00:00.000Z', payload: { model: 'fixture-gpt' } },
    { type: 'event_msg', timestamp: '2026-11-05T12:01:00.000Z', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 20 },
    } } },
  ]));

  assert.deepEqual(usage, {
    at: Date.parse('2026-11-05T12:01:00.000Z'), model: 'fixture-gpt', inputTokens: 100, outputTokens: 10,
    freshInputTokens: 80, cacheReadInputTokens: 20, cacheWriteInputTokens: null,
  });
});

test('stats.activity.a-claim-without-a-readable-native: a claim without a readable native session records unknown counts and their reason [N2]', t => {
  const commonDir = mkdtempSync(join(tmpdir(), 'pullboard-session-tokens-'));
  t.after(() => rmSync(commonDir, { recursive: true, force: true }));
  const changes = usageCheckpoint({ commonDir }, {
    agent: 'fixture-agent', item: 7, operation: 'claim', model: 'fixture-unknown', now: 10,
    environment: {}, newClaim: true, intervals: [{ key: 'claim-7', item: 7, start: 5, end: null }],
  });
  const [record] = changes.items[0].records;

  assert.equal(record.inputTokens, null);
  assert.equal(record.outputTokens, null);
  assert.ok(record.unknownReasons.includes('native-session-unavailable'));
});
