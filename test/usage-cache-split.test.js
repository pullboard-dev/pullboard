/** Synthetic native-shaped usage fixtures exercise numeric attribution, not provider execution [N2,H16]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { nativeUsage } from '../src/cost-provider.js';
import { sessionSnapshot } from '../src/cost-session.js';
import { usageDifference } from '../src/cost-session.js';
import { sanitizedUsage } from '../src/cost.js';
import { SPLIT_COUNTS } from '../src/cost-read.js';
import { sumUsage } from '../src/cost-read.js';
import { COST_ENGINE } from '../src/cost-engine.js';
import { COST_INPUT_SPLIT_ENGINE } from '../src/cost-input-split-engine.js';
import { MOVE_REGISTRY } from '../src/move-registry.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';

/** Read only the three numeric split fields under test. */
function split(row) { return SPLIT_COUNTS.map(name => row[name]); }

/** One native-shaped cumulative Codex counter, with no prompt or message content. */
function codex(input, cached, output = 0) {
  return { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count',
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } };
}

/** One native-shaped Claude usage message, without any content payload. */
function claude(id, input, read, write, output = 0) {
  return { timestamp: new Date().toISOString(), type: 'assistant', message: { id, model: 'usage-fixture',
    usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output } } };
}

/** Parse only an explicit synthetic byte buffer rather than opening any real provider session. */
function parsed(provider, rows) {
  return nativeUsage({ provider, file: 'unused-synthetic-input' }, Buffer.from(rows.map(row => JSON.stringify(row)).join('\n')));
}

/** Require the actual CLI document rather than inferring success from its printed prose. */
function document(result) {
  assert.equal(result.code ?? result.status, 0, (result.err ?? result.stderr ?? '') + (result.out ?? result.stdout ?? ''));
  return JSON.parse(result.out ?? result.stdout);
}

test('Codex differences inclusive input and cached reads independently, preserving absent writes [N2]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox();
  const file = join(box.dir, 'usage.jsonl');
  writeFileSync(file, JSON.stringify(codex(100, 60, 10)) + '\n');
  const source = { provider: 'codex', file };
  const before = sessionSnapshot(source);
  const update = codex(160, 100, 18);
  appendFileSync(file, JSON.stringify(update) + '\n' + JSON.stringify(update) + '\n');
  const after = sessionSnapshot(source, before);
  const [delta] = usageDifference(before, after, 'unknown');
  assert.deepEqual(split(delta), [20, 40, null]);
  assert.equal(delta.inputTokens, 60);
  assert.equal(delta.outputTokens, 8);
  assert.deepEqual(split(parsed('codex', [codex(9, 0)])[0]), [9, 0, null]);
  assert.deepEqual(split(parsed('codex', [codex(9, undefined)])[0]), [null, null, null]);
  assert.deepEqual(split(parsed('codex', [codex(9, '0')])[0]), [null, null, null]);
  assert.equal(parsed('codex', [codex(9, 10)])[0].freshInputTokens, null);
  const reset = parsed('codex', [codex(100, 60), codex(120, 50)]);
  assert.equal(reset[1].cacheReadInputTokens, null, 'decreased cached counters never become spend');
});

test('Claude fresh, cache reads and cache writes retain native meanings and deduplicate updates [N2]', () => {
  const rows = parsed('claude', [claude('one', 100, 60, 20, 10), claude('one', 110, 70, 25, 15)]);
  assert.equal(rows.length, 1);
  assert.deepEqual(split(rows[0]), [110, 70, 25]);
  assert.equal(rows[0].inputTokens, 205, 'the historical aggregate still includes all three provider fields');
  assert.equal(rows[0].outputTokens, 15);
  assert.deepEqual(split(parsed('claude', [claude('zero', 7, 0, 0)])[0]), [7, 0, 0]);
  assert.deepEqual(split(parsed('claude', [claude('legacy', 7, undefined, undefined)])[0]), [7, null, null]);
});

test('legacy usage retains exact replay shape and new splits require their replay floor [N2,H16]', () => {
  const legacy = { model: 'legacy', inputTokens: 12, outputTokens: 3, wallMs: 4,
    knownInputTokens: 12, knownOutputTokens: 3, unknownReasons: [] };
  assert.equal(JSON.stringify(sanitizedUsage([legacy], COST_ENGINE)[0]), JSON.stringify(legacy));
  assert.deepEqual(split(sumUsage([legacy])), [null, null, null]);
  const current = { ...legacy, freshInputTokens: 5, cacheReadInputTokens: 7, cacheWriteInputTokens: null };
  assert.deepEqual(split(sanitizedUsage([current])[0]), [5, 7, null]);
  assert.throws(() => sanitizedUsage([current], COST_ENGINE), error => error.code === 'ENGINE_VERSION');
  for (const operation of ['recordUsage', 'recordSharedUsage']) {
    assert.equal(MOVE_REGISTRY[operation].minimumEngine([{ records: [legacy] }]), COST_ENGINE);
    assert.equal(MOVE_REGISTRY[operation].minimumEngine([{ records: [current] }]), COST_INPUT_SPLIT_ENGINE);
  }
  assert.deepEqual(split(sumUsage([current, legacy])), [null, null, null]);
  assert.throws(() => sanitizedUsage([{ ...legacy, freshInputTokens: 0 }]), error => error.code === 'USAGE_RECORD');
});

for (const provider of ['codex', 'claude']) test(`synthetic ${provider} usage reaches the item's native show and stats split [N2]`, t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = document(box.run(box.repo, 'add', 'web', 'Usage split fixture', '--criterion', 'Usage split is visible.',
    '--specs', 'G1', '--check', 'test -f web/ready', '--json')).item.item_id;
  const identity = 'input-split-fixture-' + provider;
  const directory = provider === 'codex' ? join(box.dir, 'codex', 'sessions') : join(box.dir, 'claude', 'projects', 'fixture');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, provider === 'codex' ? `rollout-${identity}.jsonl` : `${identity}.jsonl`);
  const env = { ...box.env, CODEX_HOME: join(box.dir, 'codex'), CLAUDE_CONFIG_DIR: join(box.dir, 'claude') };
  for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE']) delete env[name];
  if (provider === 'codex') env.CODEX_THREAD_ID = identity;
  else env.CLAUDE_CODE_SESSION_ID = identity;
  writeFileSync(file, JSON.stringify(provider === 'codex' ? codex(100, 60, 10) : claude('anchor', 0, 0, 0)) + '\n');
  document(runFixtureChild(process.execPath, [helpers.BIN, 'claim', String(id), '--json'], { cwd: box.web, env, encoding: 'utf8' }));
  appendFileSync(file, JSON.stringify(provider === 'codex' ? codex(160, 100, 18) : claude('spent', 20, 40, 5, 8)) + '\n');
  document(runFixtureChild(process.execPath, [helpers.BIN, 'release', String(id), '--no-next', '--json'], { cwd: box.web, env, encoding: 'utf8' }));
  const shown = document(box.run(box.repo, 'show', String(id), '--json'));
  const stats = document(box.run(box.repo, 'stats', '--json'));
  const expected = provider === 'codex' ? [20, 40, null] : [20, 40, 5];
  assert.deepEqual(split(shown.usage), expected);
  assert.deepEqual(split(stats.usage.items.find(row => row.item === id)), expected);
  assert.equal(shown.usage.inputTokens, provider === 'codex' ? 60 : 65);
  assert.equal(shown.usage.outputTokens, 8);
  assert.match(box.run(box.repo, 'show', String(id)).out, /fresh 20, cached read 40, cached write (?:unknown|5)/u);
  assert.match(box.run(box.repo, 'stats').out, /fresh 20, cached read 40, cached write (?:unknown|5)/u);
  const publicData = JSON.stringify({ shown, stats });
  assert.equal(publicData.includes(identity), false);
  assert.equal(publicData.includes(file), false);
});

test('a supported historical usage record without splits shows unknown through native item and stats reads [N2,H16]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = document(box.run(box.repo, 'add', 'web', 'Legacy numeric usage', '--criterion', 'Legacy split remains unknown.',
    '--specs', 'G1', '--check', 'test -f web/ready', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  const agent = document(box.run(box.web, 'whoami', '--json')).id;
  // @pullboard-board-file journey: this isolated board receives only the supported historical recordUsage operation.
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    board.executionEngineVersion = COST_ENGINE;
    store.recordUsage(board, { agentId: agent, item: id, revision: 100, observedAt: Date.now(), records: [
      { model: 'legacy', inputTokens: 12, outputTokens: 3, wallMs: 4, knownInputTokens: 12, knownOutputTokens: 3, unknownReasons: [] },
    ] });
  } finally { store.closeBoard(board); }
  const shown = document(box.run(box.repo, 'show', String(id), '--json'));
  const stats = document(box.run(box.repo, 'stats', '--json'));
  assert.deepEqual(split(shown.usage), [null, null, null]);
  assert.deepEqual(split(stats.usage.items.find(row => row.item === id)), [null, null, null]);
  assert.equal(shown.usage.inputTokens, 12);
  assert.match(box.run(box.repo, 'show', String(id)).out, /fresh unknown, cached read unknown, cached write unknown/u);
});
