/** @pullboard-test-input source-tree */
/** @pullboard-world-pin reads the shipped model-names table and presentation.js source to prove the names live in data. */
/** @pullboard-test-loads apps/view/src/io/cost/tab.js */
/** Model and vendor names come from apps/view/data/model-names.json, not presentation.js [P5]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { modelPresentation } from '../../index.js';
import { costTabScript } from '../../src/io/cost/tab.js';
import { modelPresentation as present } from '../../src/io/presentation.js';

const MODELS = /\b(ollama|mlx|vllm|qwen|llama|mistral|gemma|deepseek|haiku|sonnet|opus|gpt-\d|gemini|openai|anthropic)\b/i;
const tables = JSON.parse(readFileSync(new URL('../../data/ceilings/model-names.json', import.meta.url), 'utf8'));

test('clause 1: presentation.js carries no model or vendor name; the tables live in the data file [P5]', () => {
  const lines = readFileSync(new URL('../../src/io/presentation.js', import.meta.url), 'utf8').split('\n');
  assert.deepEqual(lines.filter((line) => MODELS.test(line)), []);
  for (const part of ['aliases', 'known', 'vendors', 'patterns']) assert.ok(tables[part], part);
});

test('clause 1: modelPresentation returns the same results as before for every known name [P5]', () => {
  const expected = [
    ['claude-opus-5-5', '', 'claude-opus-5-5', 'Opus 5.5', 'Anthropic'],
    ['Sonnet 5.5', '', 'claude-sonnet-5-5', 'Sonnet 5.5', 'Anthropic'],
    ['claude-sonnet-5.5', '', 'claude-sonnet-5-5', 'Sonnet 5.5', 'Anthropic'],
    ['GPT_6.1_Sol', '', 'gpt-6.1-sol', 'GPT-6.1 Sol', 'OpenAI'],
    ['gpt-6.1-terra', '', 'gpt-6.1-terra', 'GPT-6.1 Terra', 'OpenAI'],
    ['GPT-6 Luna', '', 'gpt-6-luna', 'GPT-6 Luna', 'OpenAI'],
    ['GPT-6 Codex', '', 'codex', 'Codex', 'OpenAI'],
    ['GPT-6/openai', '', 'gpt-6', 'GPT-6', 'OpenAI'],
    ['gpt-5', '', 'gpt-5', 'GPT-5', 'OpenAI'],
    ['o3-mini', '', 'o3-mini', 'o3 Mini', 'OpenAI'],
    ['gemini-2-pro', '', 'gemini-2-pro', 'Gemini 2 Pro', 'Google'],
    ['claude-haiku-4-5', '', 'claude-haiku-4-5', 'Haiku 4.5', 'Anthropic'],
    ['claude-fable-2-1', '', 'claude-fable-2-1', 'Fable 2.1', 'Anthropic'],
    ['llama-3', '', 'llama-3', 'llama-3', 'Other'],
    ['llama-3', 'anthropic', 'llama-3', 'llama-3', 'Anthropic'],
    ['', '', '', '', 'Other'],
  ];
  for (const [reported, family, key, name, vendor] of expected) {
    assert.deepEqual(modelPresentation(reported, family), { key, name, vendor }, reported);
    assert.deepEqual(present(reported, family, tables), { key, name, vendor }, reported);
  }
});

test('clause 1: the browser copy of the Cost script rebuilds the same tables [P5]', () => {
  const script = costTabScript();
  assert.match(script, /const modelTables = \{/u);
  const build = new Function(`${script}\nreturn modelPresentation;`);
  assert.deepEqual(build()('GPT_6.1_Sol'), modelPresentation('GPT_6.1_Sol'));
});
