/** Approved private model names, aliases and rate matching [N26,N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelPresentation, costTabModel } from '../../src/view/cost-tab.js';
import { machine, project } from './fixture.js';

test('private model names follow the approved known, family and fallback rules [N26]', () => {
  const fixtures = [
    ['claude-opus-5-5', '', 'Opus 5.5', 'Anthropic'],
    ['GPT-6.1 Sol', '', 'GPT-6.1 Sol', 'OpenAI'],
    ['gpt-6.1-sol', '', 'GPT-6.1 Sol', 'OpenAI'],
    ['gpt-6-luna', '', 'GPT-6 Luna', 'OpenAI'],
    ['Codex', '', 'Codex', 'OpenAI'],
    ['claude-haiku-6-0', '', 'Haiku 6.0', 'Anthropic'],
    ['gpt-7-nova', '', 'GPT-7 Nova', 'OpenAI'],
    ['o12-mini', '', 'o12 Mini', 'OpenAI'],
    ['gemini-4-pro', '', 'Gemini 4 Pro', 'Google'],
    ['  Future Custom Name  ', 'ClAuDe', 'Future Custom Name', 'Anthropic'],
    ['  kimi-k3  ', '', 'kimi-k3', 'Other'],
    ['New Custom Model', 'custom future family', 'New Custom Model', 'Other'],
  ];
  for (const [reported, family, name, vendor] of fixtures) assert.deepEqual(
    { name: modelPresentation(reported, family).name, vendor: modelPresentation(reported, family).vendor }, { name, vendor }, reported);
  assert.equal(modelPresentation('GPT_6.1_Sol').key, modelPresentation('gpt-6.1-sol').key);
});

test('private prices and cumulative usage use the same model alias key [N26,N2]', () => {
  const record = (model, input, wallMs) => ({ model, freshInputTokens: input, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: input, outputTokens: 0, wallMs });
  const event = (event_id, event_kind, detail = {}) => ({ event_id, event_kind, event_by: 'web-1', item_id: 1, event_at: '2026-10-30T12:00:00Z', detail });
  const board = { agents: [{ agent_id: 'web-1', model: 'GPT-6.1 Sol', family: 'OPENAI' }], items: [{ id: 1, title: 'Native alias session' }] };
  const events = [event(1, 'claim'), event(2, 'usage', { item: 1, revision: 1, records: [record('GPT-6.1 Sol', 1_000_000, 1000)] }),
    event(3, 'usage', { item: 1, revision: 2, records: [record('gpt-6.1-sol', 2_000_000, 2000)] }), event(4, 'submit'), event(5, 'merged')];
  const before = structuredClone({ board, events });
  const priced = costTabModel(board, events, { 'GPT-6.1 Sol': { freshInput: 2, cacheRead: 0, cacheWrite: 0, output: 0 } });
  assert.equal(priced.rows[0].usageRows.length, 1, 'alias revisions remain one model session');
  assert.equal(priced.rows[0].usageRows[0].freshInputTokens, 2_000_000, 'the alias change does not count the cumulative first checkpoint twice');
  assert.equal(priced.total, 4);
  assert.deepEqual(priced.vendors.map(row => row.vendor), ['OpenAI']);
  assert.deepEqual(priced.rows[0].buildModels, ['GPT-6.1 Sol']);
  assert.equal(costTabModel(board, events).total, null, 'missing prices remain unknown');
  assert.deepEqual({ board, events }, before, 'private presentation leaves native inputs intact');
});

test('a new model and family can join a native board without a naming-table entry [N26,P5]', () => {
  const box = machine();
  const demo = project(box, 'future-model');
  const joined = JSON.parse(box.run(demo.web, 'join', 'web', '--model', 'Future Model Not In A Table', '--family', 'future custom vendor', '--json'));
  assert.equal(joined.model, 'Future Model Not In A Table');
  assert.ok(joined.agent);
});
