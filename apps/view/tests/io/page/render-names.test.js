/** @pullboard-test-input apps/view/data/ceilings/model-names.json apps/view/src/io/page/render.js */
/** @pullboard-world-pin reads render.js source and the shipped model-names table to prove model labels live in data. */
/** The page renderer names no model in code; the label rules come from model-names.json [P5]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const MODELS = /\b(ollama|mlx|vllm|qwen|llama|mistral|gemma|deepseek|haiku|sonnet|opus|gpt-\d|gemini|openai|anthropic)\b/i;
const tables = JSON.parse(readFileSync(new URL('../../../data/ceilings/model-names.json', import.meta.url), 'utf8'));

test('view.x-io-page-render-names.clause-1-render-js-no-longer-matches: clause 1: render.js no longer matches the boundary MODELS pattern [P5]', () => {
  const lines = readFileSync(new URL('../../../src/io/page/render.js', import.meta.url), 'utf8').split('\n');
  assert.deepEqual(lines.filter((line) => MODELS.test(line)), []);
});

test('view.x-io-page-render-names.clause-1-the-model-labels-are-the: clause 1: the model labels are the same as before for every spelling [P5]', () => {
  const label = (model) => tables.labels.find((entry) => new RegExp(entry.match, 'iu').test(model))?.label ?? model;
  for (const [model, want] of [['gpt-6.1-sol', 'GPT-6.1 Sol'], ['GPT 6.1 Sol', 'GPT-6.1 Sol'], ['opus-5.5', 'Claude Opus 5.5'],
    ['claude-opus-5.5', 'Claude Opus 5.5'], ['claude opus 5.5', 'Claude Opus 5.5'], ['Codex', 'Codex'], ['unknown', 'unknown'], ['llama-3', 'llama-3']]) {
    assert.equal(label(model), want, model);
  }
});
