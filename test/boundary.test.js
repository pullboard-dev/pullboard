/**
 * The boundary (P5): the core stays free of any particular model, inference engine or model vendor,
 * and of the network. Agents meet it only through the agent contract, so the core never couples to
 * the tools that run models, however useful they are. Agent tools are another matter: helping
 * Claude Code, Codex and others read the repo's rules (AGENTS.md, skills) is the core's job.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODELS = /\b(ollama|mlx|vllm|qwen|llama|mistral|gemma|deepseek|haiku|sonnet|opus|gpt-\d|gemini|openai|anthropic)\b/i;
const NETWORK = /node:(https?|http2|net|dgram|tls)\b|\bfetch\s*\(|\bWebSocket\b/;
const SECRET_LABELS = /\['(Anthropic|OpenAI) key',/;

/**
 * Every source file of the core, with its lines.
 */
function sources() {
  return ['src', 'bin'].flatMap((dir) =>
    readdirSync(join(ROOT, dir)).filter((name) => name.endsWith('.js')).map((name) => ({
      file: `${dir}/${name}`,
      lines: readFileSync(join(ROOT, dir, name), 'utf8').split('\n'),
    })),
  );
}

test('the core names no model, engine or vendor; secret patterns may name the keys they catch [P5]', () => {
  const found = sources().flatMap(({ file, lines }) =>
    lines.flatMap((line, index) => (MODELS.test(line) && !SECRET_LABELS.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(found, []);
});

test('the core opens no network connection [P5]', () => {
  const found = sources().flatMap(({ file, lines }) =>
    lines.flatMap((line, index) => (NETWORK.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(found, []);
});
