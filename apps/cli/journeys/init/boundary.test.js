/** @pullboard-test-input source-tree */
/**
 * The boundary (P5): the core stays free of any particular model, inference engine or model vendor,
 * and of the network. Agents meet it only through the agent contract, so the core never couples to
 * the tools that run models, however useful they are. Agent tools are another matter: helping
 * Claude Code, Codex and others read the repo's rules (AGENTS.md, skills) is the core's job.
 */
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../index.js';
import assert from 'node:assert/strict';
import { workingSourceInventory } from '../../../../packages/gate/src/io/scan.js';
import { packageFiles } from '../../../../packages/runners/index.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const MODELS = /\b(ollama|mlx|vllm|qwen|llama|mistral|gemma|deepseek|haiku|sonnet|opus|gpt-\d|gemini|openai|anthropic)\b/i;
const NETWORK = /node:(https?|http2|net|dgram|tls)\b|\bfetch\s*\(|\bWebSocket\b/;
const SECRET_LABELS = /\['(Anthropic|OpenAI) key',/;

/**
 * Every source file of the core, with its lines.
 * Why: the core is the shipped code that once sat in src/ and bin/; the layout move put it in every cell under
 * packages/ and apps/ except the hosted relay app, which came from relay/ (packages/codemap/data/plan) [P5].
 */
function sources() {
  const directories = [...new Set(packageFiles(ROOT)
    .filter((file) => /^(?:packages|apps)\//u.test(file) && !file.startsWith('apps/relay/') && file.endsWith('.js'))
    .map((file) => posix.dirname(file)))].sort();
  return workingSourceInventory(ROOT, directories).map(({ file, body }) => ({
    file,
    lines: body.toString('utf8').split('\n'),
  }));
}

test('the core names no model, engine or vendor; secret patterns may name the keys they catch [P5]', () => {
  const found = sources().flatMap(({ file, lines }) =>
    lines.flatMap((line, index) => (MODELS.test(line) && !SECRET_LABELS.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(found, []);
});

test('clause 1: only explicit relay commands open outbound connections; the view defaults to loopback and API stays loopback [P5, H15, H17, H19, N26, A2]', () => {
  const allowed = (file, line) =>
    // The relay transport: the one place the sync you turn on reaches the relay (#408 signing reads go through it).
    (file === 'packages/person/src/io/adapter.js' && line.trim() === 'export const realRelayAdapter = createRelayAdapter((url, options) => globalThis.fetch(url, options));') ||
    // relay on's key hand-over reads a person's public SSH keys from GitHub itself, so the relay cannot add one [E17].
    (file === 'packages/link/src/io/relay/handover.js' && line.trim() === "const response = await fetch(new URL('users/' + encodeURIComponent(login) + '/keys', base.href.endsWith('/') ? base : base.href + '/'),") ||
    (['apps/view/src/io/serve.js', 'packages/api/src/io/main.js'].includes(file) && line.trim() === "import { createServer } from 'node:http';") ||
    // The resident board serves commands over a Unix-domain socket in the machine folder, never a network address.
    (file === 'apps/cli/src/io/resident/board.js' && line.trim() === "} from 'node:net';") ||
    (file === 'apps/cli/src/io/resident/socket.js' && line.trim() === "* @param {import('node:net').Socket} socket") ||
    (file === 'apps/cli/src/io/resident/client.js' && line.trim() === "import { connect } from 'node:net';") ||
    // The board writer serves one board over a Unix-domain socket path, never a network address.
    (file === 'packages/store/src/io/board/writer.js' && ["import { createConnection } from 'node:net';", "import { createServer } from 'node:net';"].includes(line.trim())) ||
    // The runner controller reads an inherited pipe by file descriptor; it dials nothing.
    (file === 'packages/runners/src/io/controller/watch.js' && line.trim() === "import { Socket } from 'node:net';") ||
    // isIP only parses an address string for an explicit LAN view [H19]; it opens nothing.
    (file === 'apps/view/src/io/address.js' && line.trim() === "import { isIP } from 'node:net';") ||
    (file === 'packages/sync/src/io/local.js' && line.trim() === "import { request as httpRequest } from 'node:http';") ||
    // The transport cell's one wire door: the pull server and runner reach HTTP only through it, and only when the person turns them on (on one machine it is localhost) [P7].
    (file === 'packages/transport/src/io/wire.js' && /^import \{ (?:createServer|request as https?Request) \} from 'node:https?';$/u.test(line.trim())) ||
    // The remote-board client is an I/O adapter behind the board.url opt-in: the person sets board.url, so it may import node:http(s) [P7].
    (file === 'apps/cli/src/io/remote/board.js' && /^import \{ request as https?Request \} from 'node:https?';$/u.test(line.trim())) ||
    // The serve handoff only calls Server.prototype.close on the listening server it was handed, to stop it accepting; it opens nothing [C7].
    (file === 'packages/drive/src/io/handoff.js' && line.trim() === "import { Server } from 'node:net';") ||
    // Scanners that name network calls in order to refuse them.
    (file === 'apps/view/src/io/coverage.js' && /^const BROWSER_CALLS = \/\\b\(\?:/u.test(line.trim())) ||
    (file === 'packages/gate/src/io/board/write.js' && line.trim() === "if (['fetch', 'WebSocket', 'EventSource', 'globalThis.fetch', 'globalThis.WebSocket', 'globalThis.EventSource'].includes(name)) {") ||
    (file === 'packages/gate/src/io/relay.js' && /^\['[\w/.-]+', \[.*fetch\(/u.test(line.trim())) ||
    (['apps/view/src/io/serve.js'].includes(file) && line.trim() === "const reply = await fetch(address.origin + path, { headers: { 'x-pullboard-key': address.searchParams.get('k') } });") ||
    (['apps/view/src/io/session.js'].includes(file) && line.trim() === "const response = await fetch(`http://${LOOPBACK}:${view.port}/api/v1/boards?k=${encodeURIComponent(view.secret)}`, {") ||
    // The cockpit page calls its own server, and makes the one local discovery request pinned below.
    (file === 'apps/view/src/io/page/connect.js' && (line.trim() === "try { reply = await fetch(base + '/local/protocol', { signal: AbortSignal.timeout(3000), credentials: 'omit', redirect: 'error' }); }" ||
      /^const res = await fetch\(path, \{ method: body \? 'POST' : 'GET', /u.test(line.trim()))) ||
    (file === 'apps/view/src/logic/cockpit/live.js' && /^\s*const res = await fetch\(path, /.test(line));
  const found = sources().flatMap(({ file, lines }) =>
    lines.flatMap((line, index) => (NETWORK.test(line) && !allowed(file, line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(found, []);
  const cockpitSource = cockpitPage();
  const discoveryLines = cockpitSource.split('\n').filter((line) => /\bfetch\s*\(/u.test(line) && /\/local\/protocol\b/u.test(line));
  if (discoveryLines.length) {
    assert.equal(discoveryLines.length, 1, 'the cockpit makes only one local discovery request');
    assert.equal(discoveryLines[0].trim(), "try { reply = await fetch(base + '/local/protocol', { signal: AbortSignal.timeout(3000), credentials: 'omit', redirect: 'error' }); }");
    assert.match(discoveryLines[0], /signal: AbortSignal\.timeout\(3000\)/u);
    assert.match(discoveryLines[0], /credentials: 'omit'/u);
    assert.match(discoveryLines[0], /redirect: 'error'/u);
    assert.match(cockpitSource, /const LOCAL_VIEW = 'http:\/\/127\.0\.0\.1:4890';/u, 'the fallback is the fixed local-view origin');
    assert.match(cockpitSource, /const base = localSession\?\.origin \|\| LOCAL_VIEW;/u, 'the fetch base is the fixed origin or a validated local session');
    const declarations = cockpitSource.split('\n').filter((line) => /\b(?:let|const|var)\s+localSession\s*=/.test(line));
    assert.equal(declarations.length, 1, 'the local session has one declaration');
    assert.match(declarations[0], /^\s*let\s+localSession\s*=\s*null;\s*$/u, 'the local session starts empty and only guarded assignments may populate it');
    const assignments = cockpitSource.split('\n').filter((line) => /\blocalSession\s*=/.test(line) && !/\b(?:let|const|var)\s+localSession\s*=/.test(line) && !/\blocalSession\s*=\s*null\b/u.test(line));
    assert.equal(assignments.length, 2, 'both non-null local-session assignments are guarded');
    assert.ok(assignments.some((line) => /validLocalSession\(returnedSession\)\)\s*localSession\s*=\s*\{[^}]*returnedSession\.origin/u.test(line)), 'the returned session is validated before it is kept');
    assert.ok(assignments.some((line) => /validLocalSession\(kept\)\)\s*localSession\s*=\s*kept\b/u.test(line)), 'the stored session is validated before it is reused');
    const validator = /function validLocalSession\([^)]*\) \{([\s\S]*?)\n\}/u.exec(cockpitSource)?.[1];
    assert.ok(validator, 'the local session base is accepted through its validator');
    assert.match(validator, /address\.protocol\s*===\s*'http:'/u);
    assert.match(validator, /\['127\.0\.0\.1',\s*'localhost'\]\.includes\(address\.hostname\)/u);
    assert.match(validator, /address\.port\s*!==\s*''/u);
    assert.match(validator, /address\.origin\s*===\s*value\.origin/u, 'origin equality rejects credentials and non-canonical origins');
  }
  const localFetchPath = join(ROOT, 'packages/sync/src/io/local.js');
  const localFetchSource = readFileSync(localFetchPath, 'utf8');
  const httpImport = "import { request as httpRequest } from 'node:http';";
  assert.equal(localFetchSource.split(httpImport).length - 1, 1, 'the local fetch has one exact HTTP request import');
  /** Substitute a synthetic request primitive in a child so production code cannot open a socket. */
  const interceptedSource = localFetchSource.replace(httpImport, `import { EventEmitter } from 'node:events';
const requests = [];
globalThis.__localFetchRequests = requests;
const httpRequest = (url, _options, onResponse) => {
  const target = new URL(url);
  requests.push(target.href);
  const outgoing = new EventEmitter();
  outgoing.end = () => {
    const redirects = target.pathname === '/redirect';
    const incoming = Readable.from([]);
    incoming.statusCode = redirects ? 302 : 200;
    incoming.statusMessage = redirects ? 'Found' : 'OK';
    incoming.rawHeaders = redirects ? ['Location', 'http://outside.invalid/redirected'] : [];
    onResponse(incoming);
  };
  outgoing.destroy = () => {};
  return outgoing;
};`);
  const localFetchModule = `data:text/javascript;base64,${Buffer.from(interceptedSource).toString('base64')}`;
  const childSource = `
import assert from 'node:assert/strict';
const { fetchLocal, isLocalHttp } = await import(${JSON.stringify(localFetchModule)});
const allowed = ['http://127.0.0.1/', 'http://localhost/', 'http://[::1]/'];
for (const address of allowed) assert.equal(isLocalHttp(address), true, address);
const refused = ['http://outside.invalid/', 'http://127.0.0.2/', 'http://[::2]/', 'https://127.0.0.1/', 'ftp://localhost/'];
for (const address of refused) {
  assert.equal(isLocalHttp(address), false, address);
  await assert.rejects(fetchLocal(address), /local fetch requires a loopback HTTP address/);
  assert.deepEqual(globalThis.__localFetchRequests, [], 'a refused address never reaches the request primitive');
}
for (const address of ['http://127.0.0.1:8765/local', 'http://localhost:8765/local', 'http://[::1]:8765/local']) {
  const response = await fetchLocal(address);
  assert.equal(response.status, 200);
  await response.text();
}
assert.deepEqual(globalThis.__localFetchRequests, [
  'http://127.0.0.1:8765/local', 'http://localhost:8765/local', 'http://[::1]:8765/local',
]);
await assert.rejects(fetchLocal('http://127.0.0.1:8765/redirect'), /local fetch requires a loopback HTTP address/);
assert.deepEqual(globalThis.__localFetchRequests, [
  'http://127.0.0.1:8765/local', 'http://localhost:8765/local', 'http://[::1]:8765/local',
  'http://127.0.0.1:8765/redirect',
], 'the redirect target is refused before a second request');
`;
  const proof = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: ROOT, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(proof.error, undefined, `the isolated loopback proof completed: ${proof.error?.message ?? ''}`);
  assert.equal(proof.status, 0, `the isolated loopback proof passed:\n${proof.stderr}\n${proof.stdout}`);
  const serve = readFileSync(join(ROOT, 'apps/view/src/io/serve.js'), 'utf8');
  assert.match(serve, /export const LOOPBACK = '127\.0\.0\.1';/);
  assert.match(serve, /serveView\(\{[^}]*\blan = false\b[^}]*\} = \{\}\)/u, 'LAN listening requires an explicit opt-in');
  assert.match(serve, /const address = lan \? viewLanAddress\(\) : LOOPBACK;/u, 'ordinary view selects only loopback');
  assert.match(serve, /server\.listen\(port, address, /u, 'the listener uses only the explicitly selected address');
  const viewSession = readFileSync(join(ROOT, 'apps/view/src/io/session.js'), 'utf8');
  assert.match(viewSession, /import\s*\{\s*LOOPBACK\s*,\s*lastPort\s*,?\s*\}\s*from '\.\/serve\.js';/);
  assert.match(viewSession, /redirect: 'manual'/, 'the local reuse probe cannot follow a remote redirect');
  const api = readFileSync(join(ROOT, "packages/api/src/io/main.js"), 'utf8');
  assert.match(api, /const ADDRESS = '127\.0\.0\.1';/);
  assert.match(api, /export function serveApi\(\{ port = 0, address = ADDRESS,/u, 'the API binds loopback unless serve.address names another address');
  assert.match(api, /server\.listen\(port, address, /u, 'the listener uses only the selected address');
  assert.match(serve, /connect-src 'self'/, "the page may call nothing but its own server");
});
