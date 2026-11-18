/** @pullboard-test-input apps/view/data/ceilings/model-names.json apps/view/src/io/cost/overview.js */
/** @pullboard-world-pin reads overview.js source and the shipped model-names table to prove vendor names live in data. */
/** Cost overview names no vendor in code; the dot classes come from model-names.json [P5]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { costOverviewHtml } from '../../../index.js';

const MODELS = /\b(ollama|mlx|vllm|qwen|llama|mistral|gemma|deepseek|haiku|sonnet|opus|gpt-\d|gemini|openai|anthropic)\b/i;
const tables = JSON.parse(readFileSync(new URL('../../../data/ceilings/model-names.json', import.meta.url), 'utf8'));

test('view.x-io-cost-overview-names.clause-1-overview-js-no-longer-matches: clause 1: overview.js no longer matches the boundary MODELS pattern [P5]', () => {
  const lines = readFileSync(new URL('../../../src/io/cost/overview.js', import.meta.url), 'utf8').split('\n');
  assert.deepEqual(lines.filter((line) => MODELS.test(line)), []);
});

test('view.x-io-cost-overview-names.clause-1-the-dot-classes-are-the: clause 1: the dot classes are the same as before for each vendor and model name [P5]', () => {
  const row = (model, vendor) => ({ model, label: model, vendor, built: 3, accepts: 3, rate: 0, judged: true });
  const data = { builders: { rows: [row('a', 'Anthropic'), row('b', 'OpenAI'), row('c', 'Google')], best: 'a' } };
  const html = costOverviewHtml(data, null, { vendorClasses: tables.vendorClasses });
  for (const [vendor, cls] of [['Anthropic', 'anthropic'], ['OpenAI', 'openai'], ['Google', 'other']]) {
    assert.match(html, new RegExp(`<i class="${cls}" aria-hidden="true"></i>[a-c]? ?<small>${vendor}</small>`), vendor);
  }
  const sessions = costOverviewHtml({ items: [], builders: { rows: [] } }, null, { vendorClasses: tables.vendorClasses });
  assert.ok(sessions.length > 0);
});
