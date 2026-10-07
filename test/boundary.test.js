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

test('only opted-in relay sync opens outbound connections; the view and API stay on loopback [P5, N26, A2]', () => {
  const allowed = (file, line) => file === 'src/relay.js' ||
    (['src/serve.js', 'src/api.js'].includes(file) && line.trim() === "import { createServer } from 'node:http';") ||
    (file === 'src/serve.js' && line.trim() === "const reply = await fetch(address.origin + path, { headers: { 'x-pullboard-key': address.searchParams.get('k') } });") ||
    (file === 'src/cockpit.js' && /^\s*const res = await fetch\(path, /.test(line));
  const found = sources().flatMap(({ file, lines }) =>
    lines.flatMap((line, index) => (NETWORK.test(line) && !allowed(file, line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(found, []);
  const serve = readFileSync(join(ROOT, 'src', 'serve.js'), 'utf8');
  assert.match(serve, /export const LOOPBACK = '127\.0\.0\.1';/);
  assert.match(serve, /server\.listen\(port, LOOPBACK, /);
  const api = readFileSync(join(ROOT, 'src', 'api.js'), 'utf8');
  assert.match(api, /const ADDRESS = '127\.0\.0\.1';/);
  assert.match(api, /server\.listen\(port, ADDRESS, /);
  assert.match(serve, /connect-src 'self'/, "the page may call nothing but its own server");
});
