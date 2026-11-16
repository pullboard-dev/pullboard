/** pullboard mcp, driven by a real stdio MCP client against real repos and a real board [A9,P6,P5]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe } from 'node:test';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  fixtureChildMessage,
  runFixtureChild,
  runFixtureGit,
  runFixtureSetupGit,
  startFixtureChild,
} from '../../tests/fixtures/child.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../packages/kernel/index.js';
import { personNeeds } from '../../../../packages/spec/index.js';
import { personNeedsState } from '../../../view/index.js';
import {
  fileFixtureItem,
  fixtureJoinRoute,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { startFixtureLocalRunner } from '../../tests/fixtures/runner/local-start.js';
import { whenRunnerSettles } from '../../tests/fixtures/runner/local-start.js';
import { CLI_ENTRY } from '../../tests/fixtures/runner/entry.js';
import { stopFixtureLocalRunner } from '../../tests/fixtures/runner/local-stop.js';

/** Cases are collected, then run concurrently: each owns its tmp repo, machine home and runner, so they overlap their waits instead of adding them [C7]. */
const cases = [];
/** Register one case; it runs inside the concurrent suite at the end of this file. */
const test = (name, body) => cases.push([name, body]);

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const SPEC = `# MCP fixture

## G · Goals
- G1 [approved, must] The fixture keeps its board. | gate: true
- G2 [draft, aim] A draft row waits for the person.
`;

/** Network APIs the server must never touch; each attempt is logged and refused. */
const NETWORK_GUARD = `
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { appendFileSync } from 'node:fs';
const log = process.env.MCP_NETWORK_LOG;
appendFileSync(log, 'guard loaded\\n');
const blocked = (kind) => { appendFileSync(log, 'attempt ' + kind + '\\n' + new Error('network guard call site').stack + '\\n'); throw new Error('unexpected outbound attempt: ' + kind); };
globalThis.fetch = async () => blocked('fetch');
http.request = () => blocked('http.request');
http.get = () => blocked('http.get');
https.request = () => blocked('https.request');
https.get = () => blocked('https.get');
net.connect = () => blocked('net.connect');
net.createConnection = () => blocked('net.createConnection');
net.Socket.prototype.connect = function () { return blocked('net.Socket.connect'); };
tls.connect = () => blocked('tls.connect');
dgram.createSocket = () => blocked('dgram.createSocket');
`;

/** Remove every agent and SSH marker, so the environment looks like the person's own terminal. */
function personTerminal(source) {
  const env = { ...source };
  for (const key of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !key.startsWith('GIT_CONFIG') && !key.startsWith('GIT_AUTHOR') && !key.startsWith('GIT_COMMITTER')) delete env[key];
  return env;
}

/** Quote a literal executable path for the fixture's pullboard shim, which the git hooks call. */
function shellWord(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Stop only this fixture repo's registered landing workers before removing their machine home. */
async function stopFixtureLanding(root) {
  const directory = join(root, '.git', 'pullboard', 'automatic-landing');
  const owners = [];
  for (const name of ['timer.json', 'pending.json']) {
    let record;
    try { record = JSON.parse(readFileSync(join(directory, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (record.root !== root) continue;
    const owner = name === 'timer.json' ? record : record.running;
    if (owner) {
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.started) throw new Error('MCP fixture landing worker lacks process identity');
      owners.push(owner);
    }
  }
  /** A PID is owned only while its recorded OS start identity and exact fixture command match. */
  const live = owner => {
    const start = runFixtureChild('/bin/ps', ['-p', String(owner.pid), '-o', 'lstart='], { encoding: 'utf8' });
    if (start.status !== 0 || start.stdout.trim() !== owner.started) return false;
    const command = runFixtureChild('/bin/ps', ['-p', String(owner.pid), '-o', 'command='], { encoding: 'utf8' });
    return command.status === 0 && command.stdout.includes('/landing/automatic.js ') && command.stdout.includes(` ${root} `);
  };
  for (const owner of owners) if (live(owner)) {
    try { process.kill(owner.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await createE2eHelpers().waitFor(() => owners.every(owner => !live(owner)), 'MCP fixture landing workers exit');
}

/** A real repo with one lane, a joined worktree bound to agent session A, and a network guard; runner starts the machine's local runner, which only a case that submits needs. */
async function project(t, { runner = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-mcp-')));
  const clients = [];
  t.after(async () => {
    for (const { child, closed } of clients) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      let timer;
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`MCP fixture child ${child.pid} did not close`)), 10_000); // budget: owned child exit hang ceiling, not a performance assertion.
        })]);
      } finally { clearTimeout(timer); }
    }
    const jobs = join(dir, 'repo', '.git', 'pullboard', 'submit-handoffs');
    await createE2eHelpers().waitFor(() => !existsSync(jobs) || readdirSync(jobs).every(job => {
      const request = join(jobs, job, 'request.json');
      let tools = null;
      try { tools = JSON.parse(readFileSync(request, 'utf8')).tools ?? null; } catch { return false; }
      return !existsSync(join(jobs, job, 'source')) && (!tools || !existsSync(tools));
    }), 'MCP fixture submit worker cleanup');
    stopFixtureLocalRunner(join(dir, 'machine-home'));
    await stopFixtureLanding(join(dir, 'repo'));
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (error) {
      // Report only fixture-owned paths and processes; preserve the original cleanup failure.
      const failedPath = error.path ?? dir;
      let entries = [];
      try { entries = readdirSync(failedPath).slice(0, 30); } catch { /* The failing path may already be gone. */ }
      const ps = runFixtureChild('/bin/ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' });
      const processes = (ps.stdout ?? '').split('\n').filter(line => line.includes(dir)).slice(0, 20);
      error.message += `\nMCP cleanup provenance: ${JSON.stringify({ failedPath, entries, processes })}`;
      throw error;
    }
  });
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = personTerminal({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'MCP test',
    GIT_AUTHOR_EMAIL: 'mcp@example.invalid',
    GIT_COMMITTER_NAME: 'MCP test',
    GIT_COMMITTER_EMAIL: 'mcp@example.invalid',
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    MCP_NETWORK_LOG: join(dir, 'network.log'),
  });
  delete env.PULLBOARD_MODEL;
  mkdirSync(env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const guard = join(dir, 'network-guard.mjs');
  writeFileSync(guard, NETWORK_GUARD);
  /** Run real Git under the fixture's isolated identity. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  /** Run the production CLI dispatch in this process; extra holds the environment of the shell it runs from. */
  const runLocal = (cwd, args, extra = {}) => runCliInProcess(fixtureJoinRoute([...args]), { cwd, env: { ...env, ...extra } });
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const initialized = await runLocal(repo, ['init', '--model', 'coordinator-model']);
  assert.equal(initialized.status, 0, fixtureChildMessage(initialized));
  const configPath = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({ ...config, gate: 'true', spec: 'SPEC.md', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: [] }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  git(repo, 'add', '-A');
  // Setup, not the subject: this commit skips the hooks, which would each launch node [C7].
  runFixtureSetupGit(['commit', '-q', '-m', 'chore: set up mcp fixture'], { cwd: repo, env });
  const web = join(dir, 'web-1');
  git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const sessionA = { CODEX_SESSION_ID: 'mcp-session-a' };
  const joined = await joinFixtureSeat({}, web, 'web', { model: 'fixture-model', run: (cwd, ...args) => runLocal(cwd, args, sessionA) });
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  const agent = JSON.parse(joined.out).agent;
  const runLocalArgs = (cwd, ...args) => runLocal(cwd, args);
  // Pull dispatch is the default: the machine's local runner takes each submit's gate and posts its receipt.
  if (runner) startFixtureLocalRunner(env, repo, { entry: CLI_ENTRY });
  return { dir, env, runLocal, runLocalArgs, git, repo, web, agent, sessionA, guard, clients, database: join(repo, '.git', 'pullboard', 'board.sqlite') };
}

/** Wait until the item's pulled gate has settled and it left the claimed state: a pull submit returns queued at once. */
function gateSettled(box, id) {
  return whenRunnerSettles(box.env, async () => { const shown = await cli(box, box.repo, ['show', String(id)]); return shown.document.item_status === 'claimed' ? null : shown.document; },
    { deadlineMs: 120_000, what: `the pulled gate of #${id}` });
}

/** Run one CLI command with --json and return its single document and status. */
async function cli(box, cwd, args, extra = {}) {
  const result = await box.runLocal(cwd, [...args, '--json'], extra);
  let document;
  try { document = JSON.parse(result.stdout); } catch { assert.fail(`${args.join(' ')} printed no JSON\n${fixtureChildMessage(result)}`); }
  return { status: result.status, document };
}

/**
 * Start `pullboard mcp` and speak to it as a minimal MCP client: newline-delimited JSON-RPC 2.0
 * requests on its stdin, replies matched by id from its stdout, stderr kept apart for evidence.
 */
function mcpClient(t, box, cwd, extra = {}) {
  // Process-level: the stdio MCP server is a long-lived child spoken to over pipes, so it stays a real process.
  const child = startFixtureChild(process.execPath, ['--import', pathToFileURL(box.guard).href, BIN, 'mcp'], {
    cwd, env: { ...box.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const waiting = new Map();
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
  child.stdout.on('data', (part) => {
    buffer += part;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      lines.push(line);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      waiting.get(message.id)?.(message);
    }
  });
  const closed = once(child, 'close');
  box.clients.push({ child, closed });
  /** Send one request and wait for the reply with its id. */
  const request = (method, params) => new Promise((done, fail) => {
    const id = nextId++;
    const timer = setTimeout(() => fail(new Error(`no reply to ${method} within 30s\nstderr: ${stderr}`)), 30_000); // budget: hang ceiling for one MCP reply; no throughput claim.
    waiting.set(id, (message) => { clearTimeout(timer); waiting.delete(id); done(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
  });
  return {
    request,
    /** Send a notification, which gets no reply. */
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`),
    /** Call one tool and return its MCP result. */
    call: async (name, args, extra = {}) => {
      const reply = await request('tools/call', { name, arguments: args, ...extra });
      assert.ok(reply.result, `tools/call ${name} returns a tool result: ${JSON.stringify(reply)}`);
      return reply.result;
    },
    /** Close stdin, wait for a clean exit, and return everything the server wrote. */
    close: async () => {
      child.stdin.end();
      const [code] = await closed;
      return { code, lines, stderr };
    },
  };
}

/** The handshake an MCP client makes before any tool call. */
async function initialize(client, clientInfo = { name: 'fixture-client', version: '1.0.0' }) {
  const reply = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo });
  client.notify('notifications/initialized');
  return reply;
}

/** Read the board's shout and event counts without opening it through pullboard. */
function counts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      shouts: db.prepare('SELECT COUNT(*) AS n FROM shout').get().n,
      events: db.prepare('SELECT COUNT(*) AS n FROM event').get().n,
    };
  } finally { db.close(); }
}

/** Read one shout row and the event that recorded it. */
function shoutRow(file, id) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT * FROM shout WHERE shout_id = ?').get(id); } finally { db.close(); }
}

/** Read the declared kind recorded by the shout event. */
function shoutKind(file, id) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const event = db.prepare('SELECT event_detail FROM event WHERE event_kind = ? ORDER BY event_id DESC').all('shout')
      .find(row => JSON.parse(row.event_detail).shout === id);
    return event && JSON.parse(event.event_detail).messageKind;
  } finally { db.close(); }
}

/** Every line on stdout is one JSON-RPC 2.0 message; nothing else may reach it. */
function assertProtocolOnly(lines) {
  for (const line of lines) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0', `stdout carries only JSON-RPC: ${line}`);
  }
}

/** The person's decision fixture: the agent asks its coordinator, and the coordinator passes it up. */
async function personDecision(box) {
  const asked = await cli(box, box.web, ['shout', 'coordinator', 'Ship the MCP patch?', '--kind', 'question', '--decision'], box.sessionA);
  assert.equal(asked.status, 0, JSON.stringify(asked.document));
  const passed = await cli(box, box.repo, ['pass', String(asked.document.id), 'The person should decide.']);
  assert.equal(passed.status, 0, JSON.stringify(passed.document));
  return passed.document.id;
}

test('[A9,P5] an MCP client reads the board and shouts as its agent', async (t) => {
  const box = await project(t);
  const itemId = (await fileFixtureItem(box, box.repo, { lane: 'web', title: 'MCP fixture item', criterion: 'an MCP client can read this item', check: null, run: box.runLocalArgs })).item_id;
  const decisionId = await personDecision(box);

  const client = mcpClient(t, box, box.web, box.sessionA);
  const hello = await initialize(client);
  assert.equal(hello.result.protocolVersion, '2025-06-18');
  assert.deepEqual(hello.result.capabilities, { tools: {} });
  assert.equal(hello.result.serverInfo.name, 'pullboard');
  assert.equal(hello.result.serverInfo.version, JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).version);
  assert.match(hello.result.instructions, new RegExp(`agent ${box.agent} in the web lane`));

  const listed = await client.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['board_status', 'show_item', 'item_slice', 'usages', 'impact', 'cell', 'shout', 'capture_idea', 'next', 'claim', 'submit', 'verify', 'resume']);
  for (const tool of listed.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} refuses unknown arguments`);
    assert.ok(tool.description.trim(), tool.name);
  }

  const status = await client.call('board_status', {});
  assert.equal(status.isError, false, JSON.stringify(status));
  assert.equal(status.structuredContent.version, 1);
  assert.equal(status.structuredContent.me.id, box.agent, 'status reads as the seat\'s agent');
  assert.ok(status.structuredContent.items.some((item) => item.item_id === itemId && item.item_status === 'open'), 'status lists the open item');
  assert.deepEqual(status.structuredContent.needsYou.filter(need => need.kind === 'decision').map(need => need.id), [decisionId],
    'Needs-you carries the person\'s open decision');
  assert.deepEqual(status.structuredContent.needsYou, personNeeds(personNeedsState(box.web)),
    'MCP uses the same person needs builder with current row decisions');
  assert.deepEqual(JSON.parse(status.content[0].text), status.structuredContent, 'the text content is the same document');

  const shown = await client.call('show_item', { id: itemId });
  assert.equal(shown.isError, false, JSON.stringify(shown));
  const cliShown = await cli(box, box.web, ['show', String(itemId)]);
  assert.deepEqual(shown.structuredContent, cliShown.document, 'show_item returns pullboard show --json');

  const before = counts(box.database);
  const shouted = await client.call('shout', { to: 'coordinator', text: 'Hello from MCP; is this inbox visible?', kind: 'question' });
  assert.equal(shouted.isError, false, JSON.stringify(shouted));
  assert.deepEqual(Object.keys(shouted.structuredContent).sort(), ['decision', 'id', 'version']);
  const row = shoutRow(box.database, shouted.structuredContent.id);
  assert.equal(row.shout_from, box.agent, 'the shout\'s author is the seat\'s agent');
  assert.equal(row.shout_to, 'coordinator');
  assert.equal(row.shout_text, 'Hello from MCP; is this inbox visible?');
  assert.equal(shoutKind(box.database, shouted.structuredContent.id), 'question');
  const inbox = await cli(box, box.repo, ['inbox']);
  assert.ok(inbox.document.shouts.some((shout) => shout.shout_id === row.shout_id && shout.shout_from === box.agent), 'the coordinator reads it from the agent');

  const toLane = await client.call('shout', { to: 'all', text: '-- a dash-led note stays text' });
  assert.equal(toLane.isError, false, JSON.stringify(toLane));
  assert.equal(shoutRow(box.database, toLane.structuredContent.id).shout_text, '-- a dash-led note stays text');

  const idea = await client.call('capture_idea', { text: 'ideas could become their own kind of item' });
  assert.equal(idea.isError, false, JSON.stringify(idea));
  const ideaRow = shoutRow(box.database, idea.structuredContent.id);
  assert.deepEqual([ideaRow.shout_from, ideaRow.shout_to, ideaRow.shout_text], [box.agent, 'coordinator', 'idea: ideas could become their own kind of item']);
  assert.equal(shoutKind(box.database, idea.structuredContent.id), 'idea', 'capture_idea declares its coordinator kind');
  assert.equal(counts(box.database).shouts, before.shouts + 3);

  // The same engine: a refusal reaches the client with the CLI's own code, message and next step.
  const selfShout = await client.call('shout', { to: box.agent, text: 'talking to myself' });
  const cliSelf = await cli(box, box.web, ['shout', box.agent, 'talking to myself'], box.sessionA);
  assert.equal(cliSelf.status, 1);
  assert.equal(selfShout.isError, true);
  assert.equal(selfShout.structuredContent.error.code, 'SELF_SHOUT');
  assert.deepEqual(selfShout.structuredContent, cliSelf.document);
  const missing = await client.call('show_item', { id: 999 });
  assert.equal(missing.isError, true);
  assert.deepEqual(missing.structuredContent, (await cli(box, box.web, ['show', '999'])).document);
  // Values of the right type reach the CLI, so its own refusal comes back: EMPTY_SHOUT and USAGE.
  const blank = await client.call('shout', { to: 'coordinator', text: '   ' });
  const cliBlank = await cli(box, box.web, ['shout', 'coordinator', '   '], box.sessionA);
  assert.equal(cliBlank.document.error.code, 'EMPTY_SHOUT');
  assert.equal(blank.isError, true);
  assert.deepEqual(blank.structuredContent, cliBlank.document, 'a blank shout is the CLI\'s EMPTY_SHOUT');
  const blankIdea = await client.call('capture_idea', { text: '   ' });
  assert.equal(blankIdea.structuredContent.error.code, 'EMPTY_SHOUT', 'a blank idea is the CLI\'s EMPTY_SHOUT');
  const zero = await client.call('show_item', { id: 0 });
  const cliZero = await cli(box, box.web, ['show', '0']);
  assert.equal(cliZero.document.error.code, 'USAGE');
  assert.equal(zero.isError, true);
  assert.deepEqual(zero.structuredContent, cliZero.document, 'item 0 is the CLI\'s USAGE');
  const mistyped = await client.call('show_item', { id: '12' });
  assert.equal(mistyped.structuredContent.error.code, 'BAD_REQUEST', 'a value of the wrong type is still refused');

  // Arguments are exactly the schema's: no argument can name another author, seat or channel.
  const spoofed = await client.call('shout', { to: 'all', text: 'from someone else', from: 'person' });
  assert.equal(spoofed.isError, true);
  assert.equal(spoofed.structuredContent.error.code, 'BAD_REQUEST');
  assert.match(spoofed.structuredContent.error.next, /use only the arguments in its input schema/);
  const unknownTool = await client.request('tools/call', { name: 'land', arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = await client.request('resources/list');
  assert.equal(unknownMethod.error.code, -32601);
  assert.equal(counts(box.database).shouts, before.shouts + 3, 'refused calls write nothing');

  const done = await client.close();
  assert.equal(done.code, 0, done.stderr);
  assertProtocolOnly(done.lines);
  assert.equal(readFileSync(join(box.dir, 'network.log'), 'utf8'), 'guard loaded\n', 'the server opened no network connection');

  // Another agent session in the same checkout is refused exactly as the CLI refuses it there.
  const other = mcpClient(t, box, box.web, { CODEX_SESSION_ID: 'mcp-session-b' });
  await initialize(other);
  const intruder = await other.call('shout', { to: 'coordinator', text: 'not my checkout' });
  const cliIntruder = await cli(box, box.web, ['shout', 'coordinator', 'not my checkout'], { CODEX_SESSION_ID: 'mcp-session-b' });
  assert.equal(cliIntruder.document.error.code, 'NOT_YOUR_CHECKOUT');
  assert.equal(intruder.isError, true);
  assert.deepEqual(intruder.structuredContent, cliIntruder.document);
  assert.equal((await other.close()).code, 0);
  assert.equal(counts(box.database).shouts, before.shouts + 3);
});

test('board_status answers through MCP on a board with a held item [A9,N26]', async (t) => {
  const box = await project(t);
  const itemId = (await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Held MCP item', criterion: 'a held item still lets MCP read the board', check: null, run: box.runLocalArgs })).item_id;
  const claimed = await cli(box, box.web, ['claim', String(itemId)], box.sessionA);
  assert.equal(claimed.status, 0, JSON.stringify(claimed.document));

  const client = mcpClient(t, box, box.web, box.sessionA);
  await initialize(client);
  const status = await client.call('board_status', {});
  assert.equal(status.isError, false, JSON.stringify(status));
  assert.ok(status.structuredContent.items.some((item) => item.item_id === itemId && item.item_status === 'claimed'),
    'status lists the held item as claimed');
  assert.deepEqual(status.structuredContent.needsYou, personNeeds(personNeedsState(box.web)),
    'the read-only needs builder reads a held item with the board clock');
  const { code } = await client.close();
  assert.equal(code, 0);
});

test('[P6,A9] a person\'s move through MCP is refused', async (t) => {
  const box = await project(t);
  const decisionId = await personDecision(box);
  const specBefore = readFileSync(join(box.repo, 'SPEC.md'));
  const before = counts(box.database);

  // The most privileged seat, a terminal with no agent markers, and every claim a client could make.
  const spoof = { PULLBOARD_PERSON: '1', PULLBOARD_CHANNEL: 'view', PULLBOARD_AS: 'person', PULLBOARD_AGENT: 'person', PULLBOARD_PERSON_CHANNEL: 'terminal' };
  const client = mcpClient(t, box, box.repo, spoof);
  await initialize(client, { name: 'person', version: '1.0.0', title: 'The person, in their own terminal' });
  const listed = await client.request('tools/list');
  assert.ok(listed.result.tools.every((tool) => !/approv|declin|answer|sign_?off/u.test(tool.name)), 'no person move is offered');

  const claims = { _meta: { person: true, channel: 'terminal', as: 'person' } };
  const approve = await client.call('spec_approve', { ids: 'G2', as: 'person', channel: 'terminal', by: 'person' }, claims);
  const answer = await client.call('answer', { id: decisionId, text: 'Ship it.', as: 'person' }, claims);
  for (const [name, result] of [['spec approve', approve], ['answer', answer]]) {
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.error.code, 'HUMAN_REQUIRED', `${name}: ${JSON.stringify(result.structuredContent)}`);
    assert.match(result.structuredContent.error.next, /^ask your coordinator to bring it to the person/u, name);
  }
  for (const name of ['spec_decline', 'spec_signoff', 'approveRows', 'Spec.Approve', 'answer-decision', 'sign off']) {
    const refused = await client.call(name, { ids: 'G2' });
    assert.equal(refused.structuredContent.error.code, 'HUMAN_REQUIRED', name);
  }
  const done = await client.close();
  assert.equal(done.code, 0, done.stderr);
  assertProtocolOnly(done.lines);

  assert.deepEqual(counts(box.database), before, 'no shout or event was written');
  assert.deepEqual(readFileSync(join(box.repo, 'SPEC.md')), specBefore, 'SPEC.md is unchanged');
  const open = await cli(box, box.repo, ['decisions', '--as', 'person']);
  assert.ok(open.document.decisions.some((ask) => ask.shout_id === decisionId), 'the decision is still open');
  // The same moves are possible from the person's own terminal, so the refusal is MCP's, not the fixture's.
  const approved = await cli(box, box.repo, ['spec', 'approve', 'G2']);
  assert.equal(approved.status, 0, JSON.stringify(approved.document));
});

test('an agent claims, submits, verifies and resumes through MCP with the CLI\'s refusals [A9,P6]', async (t) => {
  const box = await project(t, { runner: true });
  const id = (await fileFixtureItem(box, box.repo, { lane: 'web', title: 'An item worked through MCP', criterion: 'web/mcp.txt exists.', args: ['--specs', 'G1'], check: null, run: box.runLocalArgs })).item_id;
  const builder = mcpClient(t, box, box.web, box.sessionA);
  await initialize(builder);
  const names = (await builder.request('tools/list')).result.tools.map((tool) => tool.name);
  for (const name of ['next', 'claim', 'submit', 'verify', 'resume']) assert.ok(names.includes(name), `MCP offers ${name}`);

  // The same refusal, code and next step, whether the CLI or MCP makes the move.
  const missing = await builder.call('claim', { id: 9999 });
  const cliMissing = await cli(box, box.web, ['claim', '9999'], box.sessionA);
  assert.equal(missing.isError, true);
  assert.equal(cliMissing.status, 1);
  assert.deepEqual(missing.structuredContent.error, cliMissing.document.error, 'a refused claim reads the same through MCP');

  const claimed = await builder.call('claim', { id });
  assert.equal(claimed.isError, false, JSON.stringify(claimed.structuredContent));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'mcp.txt'), 'made through MCP\n');
  box.git(box.web, 'add', 'web/mcp.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): write the MCP fixture file [G1]');
  const submitted = await builder.call('submit', { id });
  assert.equal(submitted.isError, false, JSON.stringify(submitted.structuredContent));
  await gateSettled(box, id);
  const commit = box.git(box.web, 'rev-parse', 'HEAD').trim();

  // A builder never verifies its own work, through MCP as through the CLI.
  const own = await builder.call('verify', { id, decision: 'accept', note: 'I built it.' });
  const cliOwn = await cli(box, box.web, ['verify', String(id), 'accept', '--note', 'I built it.'], box.sessionA);
  assert.equal(own.isError, true);
  assert.equal(own.structuredContent.error.code, cliOwn.document.error.code, 'self-verification is refused alike');
  const resumed = await builder.call('resume', {});
  assert.equal(resumed.isError, false, JSON.stringify(resumed.structuredContent));
  assert.equal(resumed.structuredContent.version, 1);
  assert.equal(resumed.structuredContent.view.state, 'off', 'MCP resume never starts or probes a background view');
  assertProtocolOnly((await builder.close()).lines);

  // Another agent, in its own session, takes the review and accepts through MCP.
  const review = join(box.dir, 'review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  const sessionB = { CODEX_SESSION_ID: 'mcp-session-b' };
  const reviewerJoined = await cli(box, review, ['join', 'web', '--model', 'reviewer-model'], sessionB);
  assert.equal(reviewerJoined.status, 0, JSON.stringify(reviewerJoined.document));
  const reviewer = mcpClient(t, box, review, sessionB);
  await initialize(reviewer);
  const reserved = await reviewer.call('next', { verify: true });
  assert.equal(reserved.isError, false, JSON.stringify(reserved.structuredContent));
  const accepted = await reviewer.call('verify', { id, decision: 'accept', note: 'web/mcp.txt exists at the submitted commit.' });
  assert.equal(accepted.isError, false, JSON.stringify(accepted.structuredContent));
  assertProtocolOnly((await reviewer.close()).lines);
  const shown = await cli(box, box.repo, ['show', String(id)]);
  assert.equal(shown.document.item_status, 'verified', 'the item was claimed, submitted and verified through MCP alone');
  const networkLog = readFileSync(box.env.MCP_NETWORK_LOG, 'utf8');
  assert.equal(networkLog.includes('attempt'), false, `no tool opened a network connection\n${networkLog}`);

  // init registered the server for both clients, keeping what was already there.
  const servers = JSON.parse(readFileSync(join(box.repo, '.mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(servers.pullboard.args.slice(0, 1), ['-c']);
  assert.match(servers.pullboard.args[1], /exec "\$p" mcp/u);
  assert.match(readFileSync(join(box.repo, '.codex', 'config.toml'), 'utf8'), /^\[mcp_servers\.pullboard\]$/mu);
  const other = join(box.dir, 'other');
  mkdirSync(join(other, '.codex'), { recursive: true });
  box.git(box.dir, 'init', '-q', '-b', 'main', other);
  writeFileSync(join(other, '.mcp.json'), `${JSON.stringify({ mcpServers: { mine: { command: 'mine' } } })}\n`);
  writeFileSync(join(other, '.codex', 'config.toml'), 'model = "mine"\n\n[mcp_servers.mine]\ncommand = "mine"\n');
  const merged = await box.runLocal(other, ['init', '--model', 'coordinator-model']);
  assert.equal(merged.status, 0, fixtureChildMessage(merged));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(other, '.mcp.json'), 'utf8')).mcpServers).sort(), ['mine', 'pullboard'], 'an existing server is kept');
  const toml = readFileSync(join(other, '.codex', 'config.toml'), 'utf8');
  assert.ok(toml.startsWith('model = "mine"\n\n[mcp_servers.mine]\ncommand = "mine"\n'), 'existing Codex settings are kept as written');
  assert.match(toml, /^\[mcp_servers\.pullboard\]$/mu);
  const again = await box.runLocal(other, ['init', '--model', 'coordinator-model']);
  assert.equal(readFileSync(join(other, '.codex', 'config.toml'), 'utf8'), toml, 'a second init adds nothing');
  assert.ok(again.status === 0 || again.status === 1, 'a second init leaves the registration alone');
});

test('MCP rejects require and preserve caller-supplied frozen wording [A9,V6,H16]', async t => {
  const box = await project(t, { runner: true });
  const clause = 'web/mcp.txt contains a heading.';
  const id = (await fileFixtureItem(box, box.repo, { lane: 'web', title: 'A quoted MCP rejection', criterion: clause, args: ['--specs', 'G1'], check: null, run: box.runLocalArgs })).item_id;
  assert.equal((await cli(box, box.web, ['claim', String(id)], box.sessionA)).status, 0);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'mcp.txt'), '<p>The heading is absent.</p>\n');
  box.git(box.web, 'add', 'web/mcp.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): write the rejected MCP fixture [G1]');
  const submitted = await cli(box, box.web, ['submit', String(id)], box.sessionA);
  assert.equal(submitted.status, 0, JSON.stringify(submitted.document));
  await gateSettled(box, id);
  const review = join(box.dir, 'clause-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, box.git(box.web, 'rev-parse', 'HEAD').trim());
  const session = { CODEX_SESSION_ID: 'mcp-clause-reviewer' };
  assert.equal((await cli(box, review, ['join', 'web', '--model', 'reviewer-model'], session)).status, 0);
  const reviewer = mcpClient(t, box, review, session);
  await initialize(reviewer);
  const input = { id, decision: 'reject', reason: 'TEST_FAILURE', note: 'The required heading is absent.' };
  const missing = await reviewer.call('verify', input);
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, 'BAR_CLAUSE_REQUIRED');
  assert.equal((await reviewer.call('verify', { ...input, clause: true })).isError, true);
  const rejected = await reviewer.call('verify', { ...input, clause });
  assert.equal(rejected.isError, false, JSON.stringify(rejected.structuredContent));
  assert.equal(rejected.structuredContent.clause, clause);
  const shown = await cli(box, box.repo, ['show', String(id)]);
  assert.equal(shown.document.verdicts[0].clause, clause);
  assertProtocolOnly((await reviewer.close()).lines);
});


test('MCP code-map tools pin usages, impact and cell answers and refuse escaping paths [A9,C7,D3]', async t => {
  const box = await project(t);
  const files = {
    'package.json': JSON.stringify({ type: 'module' }),
    'src/leaf.js': 'export function leaf() { return 1; }\n',
    'src/caller.js': "import { leaf as chosen } from './leaf.js';\nexport function caller() { return chosen(); }\n",
    'test/leaf.test.js': "import { caller } from '../src/caller.js';\ncaller();\n",
    'test/other.test.js': 'export const unrelated = true;\n',
    'packages/codemap/data/plan/cells.json': JSON.stringify({ cells: [{ file: 'packages/codemap/data/plan/01-leaf.json' }, { file: 'packages/codemap/data/plan/02-callers.json' }], stays: [] }),
    'packages/codemap/data/plan/01-leaf.json': JSON.stringify({ order: 1, name: 'leaf', frontDoor: 'src/leaf.js', paths: [['src/leaf.js', 'packages/leaf/index.js', 'seed']], reexports: [], cuts: [] }),
    'packages/codemap/data/plan/02-callers.json': JSON.stringify({ order: 2, name: 'callers', frontDoor: 'src/caller.js', paths: [['src/caller.js', 'packages/callers/index.js', 'seed']], reexports: [], cuts: [] }),
    'packages/codemap/data/plan/temporary-edges.json': JSON.stringify({ version: 1, edges: [] }),
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(resolve(box.repo, file, '..'), { recursive: true });
    writeFileSync(join(box.repo, file), source);
  }
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: commit code-map fixture');
  box.git(box.web, 'merge', '--ff-only', 'main');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const client = mcpClient(t, box, box.web, box.sessionA);
  await initialize(client);
  const requests = [['usages', { target: 'src/leaf.js#leaf' }], ['impact', { files: ['src/leaf.js'] }], ['cell', { path: 'src/caller.js' }]];
  const answers = [];
  for (const [name, args] of requests) {
    const first = await client.call(name, args);
    assert.equal(first.isError, false, JSON.stringify(first));
    assert.deepEqual(await client.call(name, args), first, `${name} is deterministic at the same commit`);
    assert.equal(first.structuredContent.commit, commit);
    answers.push(first.structuredContent);
  }
  assert.deepEqual(answers[0].importers, ['src/caller.js']);
  assert.deepEqual(answers[0].callers, [{ file: 'src/caller.js', function: 'caller', line: 2 }]);
  assert.equal(answers[0].complete, false, 'static observations never claim a complete dynamic call graph');
  assert.deepEqual(answers[1].dependentModules, ['src/caller.js', 'test/leaf.test.js']);
  assert.deepEqual(answers[1].tests.files, ['test/leaf.test.js']);
  assert.equal(answers[1].tests.full, false);
  assert.equal(answers[2].cell, 'callers');
  assert.equal(answers[2].frontDoor, 'src/caller.js');
  assert.deepEqual(answers[2].allowedImports, ['leaf']);
  writeFileSync(join(box.web, 'src/caller.js'), 'export function caller() {}\n');
  assert.deepEqual((await client.call('usages', requests[0][1])).structuredContent, answers[0], 'dirty working bytes do not replace committed source');
  for (const [name, args] of [['usages', { target: '../outside.js#leaf' }], ['impact', { files: ['/outside.js'] }], ['cell', { path: 'src/../../outside.js' }]]) {
    const refused = await client.call(name, args);
    assert.equal(refused.isError, true, name);
    assert.equal(refused.structuredContent.error.code, 'BAD_REQUEST');
    assert.match(refused.structuredContent.error.message, /outside the repository/u);
  }
  const wrong = await client.call('impact', { files: 'src/leaf.js' });
  assert.equal(wrong.isError, true, 'the array schema is enforced before graph reads');
  box.git(box.web, 'restore', 'src/caller.js');
  writeFileSync(join(box.repo, 'src/opaque.js'), "export const load = name => import(name);\n");
  writeFileSync(join(box.repo, 'test/opaque.test.js'), "import { load } from '../src/opaque.js';\nexport { load };\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add an opaque import control');
  box.git(box.web, 'merge', '--ff-only', 'main');
  const opaque = await client.call('impact', { files: ['src/leaf.js'] });
  assert.equal(opaque.isError, false);
  assert.equal(opaque.structuredContent.tests.full, false, 'the native selector retains the opaque root without dropping known dependent tests');
  assert.match(opaque.structuredContent.tests.reason, /unresolved root closures retained/u);
  assert.ok(opaque.structuredContent.unknown.some(row => row.file === 'src/opaque.js'));
  assert.deepEqual(opaque.structuredContent.tests.files, ['test/leaf.test.js', 'test/opaque.test.js']);
  assert.equal((await client.close()).code, 0);
});

describe('MCP journeys [A9,P6,C7]', { concurrency: true }, () => {
  for (const [name, body] of cases) it(name, body);
});
