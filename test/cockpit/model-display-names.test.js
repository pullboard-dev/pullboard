// pullboard: browser
/** @pullboard-test-gui */
/** Approved private model names, aliases and rate matching [N26,N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelPresentation, costTabModel } from '../../apps/view/index.js';
import { machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press } from './fixture.js';
import { join } from 'node:path';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../apps/cli/index.js';

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
    ['constructor', 'constructor', 'constructor', 'Other'],
    ['__proto__', '__proto__', '__proto__', 'Other'],
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
  const priced = costTabModel(board, events, { 'GPT-6.1 Sol': { freshInput: 2, cacheReadInput: 0, cacheWriteInput: 0, output: 0 } });
  assert.equal(priced.rows[0].usageRows.length, 1, 'alias revisions remain one model session');
  assert.equal(priced.rows[0].usageRows[0].freshInputTokens, 2_000_000, 'the alias change does not count the cumulative first checkpoint twice');
  assert.equal(priced.total, 4);
  const parallelAliases = [event(1, 'claim'), event(2, 'usage', { item: 1, revision: 1, records: [record('GPT-6.1 Sol', 1_000_000, 1000), record('gpt-6.1-sol', 2_000_000, 2000)] }),
    event(3, 'usage', { item: 1, revision: 2, records: [record('GPT-6.1 Sol', 2_000_000, 2000), record('gpt-6.1-sol', 4_000_000, 4000)] }), event(4, 'submit'), event(5, 'merged')];
  const merged = costTabModel(board, parallelAliases, { 'GPT-6.1 Sol': { freshInput: 2, cacheReadInput: 0, cacheWriteInput: 0, output: 0 } });
  assert.equal(merged.rows[0].usageRows.length, 1);
  assert.equal(merged.rows[0].usageRows[0].freshInputTokens, 6_000_000, 'aliases in the same revision share a cumulative baseline');
  assert.equal(merged.total, 12);
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


test('private naming code is absent from public and relay pages [N26,N2]', () => {
  assert.match(cockpitPage(''), /const modelPresentation =/u);
  for (const options of [{ snapshot: true }, { readOnly: true }, { transportModule: '/relay/client.js' }, { hostedLocal: true }]) {
    assert.doesNotMatch(cockpitPage('', options), /const modelPresentation =/u, 'private naming tables stay out of public surfaces');
  }
});

test('private Items and Shouts share a model name without rewriting the native API [N26,P5]', { timeout: 120_000 }, async () => {
  const box = machine();
  const demo = project(box, 'private-model-view');
  box.run(demo.web, 'join', 'web', '--model', 'gpt-6.1-sol', '--family', 'openai');
  box.run(demo.repo, 'add', 'web', 'Private model presentation', '--specs', 'G1', '--criterion', 'the native seat keeps its model');
  box.run(demo.web, 'claim', '1');
  const server = await startView(box);
  let chrome;
  try {
    const executable = chromeExecutable(); assert.ok(executable, 'real Chrome is required');
    chrome = await openSnapshotChrome(executable, server.link.href, join(box.dir, 'private-model-chrome'));
    await chrome.waitFor('!!data?.project');
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.querySelector('#chain [data-item=\"1\"] .item-seat')");
    assert.equal(await chrome.stable("document.querySelector('#chain [data-item=\"1\"] .item-seat').textContent.trim()"), 'web-1');
    assert.equal(await chrome.stable("document.querySelector('#chain [data-item=\"1\"] .item-seat').title.split(' · ')[0]"), 'GPT-6.1 Sol');
    await press(chrome, "document.querySelector('[data-tab=shouts]')");
    await chrome.waitFor("document.querySelector('.agent-card .agent-model')");
    assert.ok((await chrome.stable("document.querySelector('#agents').textContent")).includes('GPT-6.1 Sol'));
    assert.equal(await chrome.stable("data.project.agents.find(agent => agent.agent_id === 'web-1').model"), 'gpt-6.1-sol', 'presentation never rewrites the native observation');
    assert.deepEqual(chrome.exceptions, []);
  } finally { if (chrome) await closeSnapshotChrome(chrome); await server.stop(); }
});
