/** Synthetic native-shaped usage fixtures exercise numeric attribution, not provider execution [N2,H16]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { openBoard } from '../../../../../lib/index.js';
import { nativeUsage } from '../../../../../../packages/stats/index.js';
import { sessionSnapshot } from '../../../../../../packages/stats/index.js';
import { usageDifference } from '../../../../../../packages/stats/index.js';
import { sanitizedUsage } from '../../../../../../packages/stats/index.js';
import { SPLIT_COUNTS } from '../../../../../../packages/stats/index.js';
import { sumUsage } from '../../../../../../packages/stats/index.js';
import { COST_ENGINE } from '../../../../../../packages/state/light.js';
import { COST_INPUT_SPLIT_ENGINE } from '../../../../../../packages/state/light.js';
import { MOVE_REGISTRY } from '../../../../../../packages/moves/index.js';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../../tests/fixtures/child.js';
import { fixtureAdd } from '../../../../tests/fixtures/testkit.js';

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

test('Codex differences inclusive input and cached reads independently, preserving absent writes [N2]', async t => {
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
  const inconsistent = parsed('codex', [codex(9, 10), codex(12, 4), codex(15, 6)]);
  assert.deepEqual(split(inconsistent[0]), [null, null, null], 'cached input cannot exceed inclusive input');
  assert.deepEqual(split(inconsistent[1]), [null, null, null], 'an invalid cached count never becomes a spend baseline');
  assert.deepEqual(split(inconsistent[2]), [1, 2, null], 'a subsequent pair of valid counters restores differencing');
  assert.equal(inconsistent[1].inputTokens, 3, 'valid inclusive input keeps its independent baseline');
  const reset = parsed('codex', [codex(100, 60, 10), codex(120, 50, 15), codex(130, 55, 17)]);
  assert.deepEqual(split(reset[1]), [null, null, null], 'a cached-counter decrease also invalidates derived fresh spend');
  assert.equal(reset[1].inputTokens, 20);
  assert.equal(reset[1].outputTokens, 5);
  assert.deepEqual(split(reset[2]), [5, 5, null], 'a subsequent valid interval restores the split baseline');
  const interval = parsed('codex', [codex(100, 10, 10), codex(120, 40, 15), codex(130, 45, 17)]);
  assert.deepEqual(split(interval[1]), [null, null, null], 'cached interval input cannot exceed inclusive interval input');
  assert.equal(interval[1].inputTokens, 20);
  assert.equal(interval[1].outputTokens, 5);
  assert.deepEqual(split(interval[2]), [5, 5, null]);
  writeFileSync(file, JSON.stringify(codex(100, 60, 10)) + '\n');
  const resetBefore = sessionSnapshot(source);
  appendFileSync(file, JSON.stringify(codex(120, 50, 15)) + '\n');
  const [resetDelta] = usageDifference(resetBefore, sessionSnapshot(source, resetBefore), 'unknown');
  assert.deepEqual(split(resetDelta), [null, null, null], 'public anchored differencing preserves the reset uncertainty');
  assert.equal(resetDelta.inputTokens, 20);
  assert.equal(resetDelta.outputTokens, 5);
});

test('Claude fresh, cache reads and cache writes retain native meanings and deduplicate updates [N2]', async () => {
  const rows = parsed('claude', [claude('one', 100, 60, 20, 10), claude('one', 110, 70, 25, 15)]);
  assert.equal(rows.length, 1);
  assert.deepEqual(split(rows[0]), [110, 70, 25]);
  assert.equal(rows[0].inputTokens, 205, 'the historical aggregate still includes all three provider fields');
  assert.equal(rows[0].outputTokens, 15);
  assert.deepEqual(split(parsed('claude', [claude('zero', 7, 0, 0)])[0]), [7, 0, 0]);
  assert.deepEqual(split(parsed('claude', [claude('legacy', 7, undefined, undefined)])[0]), [7, null, null]);
});

test('legacy usage retains exact replay shape and new splits require their replay floor [N2,H16]', async () => {
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

for (const provider of ['codex', 'claude']) test(`clause 1: synthetic ${provider} usage reaches the item's native show and stats split [N2]`, async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = document((await fixtureAdd(box.runLocal, box.repo, 'web', 'Usage split fixture', '--criterion', 'Usage split is visible.',
    '--brief', 'Files: web/ready\nTest: synthetic usage is visible in native item and stats reads\nChange: seed a lightweight provider usage fixture.',
    '--route', 'mid', '--specs', 'G1', '--check', 'test -f web/ready', '--json'))).item.item_id;
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
  document(runFixtureChild(process.execPath, [helpers.BIN, 'release', String(id), '--reason', 'OTHER', '--note', 'finish synthetic usage fixture', '--no-next', '--json'], { cwd: box.web, env, encoding: 'utf8' }));
  const shown = document((await box.runLocal(box.repo, 'show', String(id), '--json')));
  const stats = document((await box.runLocal(box.repo, 'stats', '--json')));
  const expected = provider === 'codex' ? [20, 40, null] : [20, 40, 5];
  assert.deepEqual(split(shown.usage), expected);
  assert.deepEqual(split(stats.usage.items.find(row => row.item === id)), expected);
  assert.equal(shown.usage.inputTokens, provider === 'codex' ? 60 : 65);
  assert.equal(shown.usage.outputTokens, 8);
  assert.match((await box.runLocal(box.repo, 'show', String(id), '--detail')).out, /fresh 20, cached read 40, cached write (?:unknown|5)/u);
  assert.match((await box.runLocal(box.repo, 'stats')).out, /fresh 20, cached read 40, cached write (?:unknown|5)/u);
  const publicData = JSON.stringify({ shown, stats });
  assert.equal(publicData.includes(identity), false);
  assert.equal(publicData.includes(file), false);
});

test('clause 1: a supported historical usage record without splits shows unknown through native item and stats reads [N2,H16]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = document((await fixtureAdd(box.runLocal, box.repo, 'web', 'Legacy numeric usage', '--criterion', 'Legacy split remains unknown.',
    '--brief', 'Files: web/ready\nTest: historical usage without split counters displays unknown in item and stats reads\nChange: seed a supported historical usage record.',
    '--route', 'mid', '--specs', 'G1', '--check', 'test -f web/ready', '--json'))).item.item_id;
  document((await box.runLocal(box.web, 'claim', String(id), '--json')));
  const agent = document((await box.runLocal(box.web, 'whoami', '--json'))).id;
  // @pullboard-board-file journey: this isolated board receives only the supported historical recordUsage operation.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    board.executionEngineVersion = COST_ENGINE;
    store.recordUsage(board, { agentId: agent, item: id, revision: 100, observedAt: Date.now(), records: [
      { model: 'legacy', inputTokens: 12, outputTokens: 3, wallMs: 4, knownInputTokens: 12, knownOutputTokens: 3, unknownReasons: [] },
    ] });
  } finally { store.closeBoard(board); }
  const shown = document((await box.runLocal(box.repo, 'show', String(id), '--json')));
  const stats = document((await box.runLocal(box.repo, 'stats', '--json')));
  assert.deepEqual(split(shown.usage), [null, null, null]);
  assert.deepEqual(split(stats.usage.items.find(row => row.item === id)), [null, null, null]);
  assert.equal(shown.usage.inputTokens, 12);
  assert.match((await box.runLocal(box.repo, 'show', String(id), '--detail')).out, /fresh unknown, cached read unknown, cached write unknown/u);
});
