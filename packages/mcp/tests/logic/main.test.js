/** The mcp cell speaks newline-delimited JSON-RPC, validates every tool call, refuses a person's move and runs the CLI's own argv [A9,P6,P5,C7]. */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { refusePersonMove } from '../../index.js';
import { serveMcp } from '../../index.js';

/** A refusal formatter shaped like the CLI's: the code and message under error. */
const formatRefusal = error => ({ version: 1, error: { code: error.code, message: error.message } });

/**
 * Serve the given JSON-RPC messages (objects, or raw strings for malformed lines) against a recording runCommand stand-in.
 *
 * @param {(argv: string[], context: object) => Promise<{ status: number, document: object }>} respond - The stand-in CLI.
 * @param {(object | string)[]} messages
 * @param {object} [options] - Extra serveMcp options such as readCodeMap.
 * @returns {Promise<{ replies: object[], calls: { argv: string[], context: object }[], log: string }>}
 */
async function serve(respond, messages, options = {}) {
  const calls = [];
  const output = [];
  const log = [];
  const lines = messages.map(message => `${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  await serveMcp({
    cwd: '/seat',
    input: Readable.from(lines),
    output: { write: text => output.push(text) },
    log: { write: text => log.push(text) },
    readPersonNeeds: () => [{ kind: 'decision', id: 'D1' }],
    formatRefusal,
    ...options,
    async runCommand(argv, context) {
      calls.push({ argv, context });
      const { status, document } = await respond(argv, context);
      context.stdout.write(JSON.stringify(document));
      return status;
    },
  });
  return { replies: output.join('').split('\n').filter(Boolean).map(line => JSON.parse(line)), calls, log: log.join('') };
}

/** A stand-in CLI whose seat is a known agent and whose every other command answers one echo document. */
const seated = (extra = {}) => async argv => {
  if (argv[0] === 'whoami') return { status: 0, document: { version: 1, id: 'core-1', lane: 'core' } };
  if (Object.hasOwn(extra, argv[0])) return extra[argv[0]](argv);
  return { status: 0, document: { version: 1, argv } };
};

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('MCP refuses missing native readers or formatters before consuming protocol input [A9,C7]', async t => {
  const input = Readable.from(['{"jsonrpc":"2.0","id":1,"method":"initialize"}\n']);
  const output = new PassThrough();
  const log = new PassThrough();
  t.after(() => { input.destroy(); output.destroy(); log.destroy(); });
  for (const readPersonNeeds of [undefined, {}]) {
    await assert.rejects(serveMcp({ cwd: process.cwd(), input, output, log, readPersonNeeds,
      runCommand: () => assert.fail('missing composition must be refused before a CLI call') }),
    error => error.code === 'BAD_REQUEST' && /native person-needs reader/u.test(error.message));
  }
  await assert.rejects(serveMcp({ cwd: process.cwd(), input, output, log, readPersonNeeds: () => [],
    runCommand: () => assert.fail('missing formatter must be refused before a CLI call') }),
  error => error.code === 'BAD_REQUEST' && /native refusal formatter/u.test(error.message));
  assert.equal(input.readableFlowing, null, 'no protocol input was consumed');
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(output.readableLength, 0, 'no successful protocol reply was emitted');
  assert.equal(log.readableLength, 0);
});

test('MCP answers initialize with the requested protocol version or its first, names the seat, and ignores notifications [A9]', async () => {
  const { replies, calls } = await serve(seated(), [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
  ]);
  assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3], 'the notification got no reply');
  assert.equal(replies[0].result.protocolVersion, '2024-11-05');
  assert.equal(replies[1].result.protocolVersion, '2025-06-18');
  assert.deepEqual(replies[0].result.capabilities, { tools: {} });
  assert.match(replies[0].result.instructions, /agent core-1 in the core lane/u);
  assert.deepEqual(replies[2].result, {});
  assert.deepEqual(calls.map(entry => entry.argv), [['whoami', '--json']], 'only whoami ran: protocol traffic never reaches the board');
});

test('MCP reports a checkout without an agent on its log and still serves [A9]', async () => {
  const { replies, log } = await serve(async () => ({ status: 1, document: { error: { message: 'no agent here', next: 'run join' } } }), [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
  ]);
  assert.match(replies[0].result.instructions, /for this checkout/u);
  assert.match(log, /no agent here\nnext: run join/u);
  assert.equal(replies.length, 1, 'the log is not the protocol channel');
});

test('MCP lists every tool with a closed input schema, and offers no person move [A9,P6]', async () => {
  const { replies } = await serve(seated(), [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const { tools } = replies[0].result;
  assert.deepEqual(tools.map(tool => tool.name), ['board_status', 'show_item', 'item_slice', 'usages', 'impact', 'cell', 'shout', 'capture_idea', 'next', 'claim', 'submit', 'verify', 'resume']);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} refuses unknown arguments`);
    assert.doesNotThrow(() => refusePersonMove(tool.name), `${tool.name} is not a person move`);
  }
});

test('MCP answers malformed lines, bad requests and unknown methods with JSON-RPC errors in order [A9]', async () => {
  const { replies } = await serve(seated(), [
    'not json',
    '[1]',
    { jsonrpc: '2.0', id: 'a', method: 'nope' },
    { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: {} },
    call('c', 'no_such_tool', {}),
  ]);
  assert.deepEqual(replies.map(reply => reply.error.code), [-32700, -32600, -32601, -32602, -32602]);
  assert.equal(replies[2].id, 'a');
  assert.equal(replies[4].error.data.error.code, 'UNKNOWN_TOOL');
});

test('MCP refuses a person move by any spelling before it reads arguments or runs the CLI [A9,P6]', async () => {
  const names = ['approve_row', 'declineRow', 'answer-decision', 'Sign.Off', 'sign off', 'checkAccept', 'decide'];
  const { replies, calls } = await serve(seated(), names.map((name, index) => call(index, name, { whatever: true })));
  for (const reply of replies) {
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result.structuredContent.error.code, 'HUMAN_REQUIRED');
  }
  assert.equal(replies.length, names.length);
  assert.deepEqual(calls.map(entry => entry.argv[0]), ['whoami'], 'no refused call reached the CLI');
});

test('MCP validates arguments against the tool schema: unknown, missing, mistyped and out-of-enum values are refused [A9,C7]', async () => {
  const bad = [
    call(1, 'show_item', { id: 1, channel: 'person' }),
    call(2, 'show_item', {}),
    call(3, 'show_item', { id: '1' }),
    call(4, 'show_item', { id: 1.5 }),
    call(5, 'shout', { to: 'all', text: 'hi', kind: 'rant' }),
    call(6, 'shout', { to: 'all', text: 7 }),
    call(7, 'next', { verify: 'yes' }),
    call(8, 'impact', { files: [] }),
    call(9, 'impact', { files: ['a.js', 3] }),
    call(10, 'resume', 'loose'),
    call(11, 'verify', { id: 1, decision: 'maybe', note: 'x' }),
  ];
  const { replies, calls } = await serve(seated(), bad);
  assert.equal(replies.length, bad.length);
  for (const reply of replies) {
    assert.equal(reply.result.isError, true, JSON.stringify(reply));
    assert.equal(reply.result.structuredContent.error.code, 'BAD_REQUEST');
  }
  assert.deepEqual(calls.map(entry => entry.argv[0]), ['whoami']);
});

test('MCP runs each loop move as the CLI argv it mirrors, flags as --name=value and positionals after -- [A9,P6]', async () => {
  const { replies, calls } = await serve(seated(), [
    call(1, 'next', {}),
    call(2, 'next', { verify: true }),
    call(3, 'claim', { id: 12 }),
    call(4, 'submit', { id: 12 }),
    call(5, 'submit', { id: 12, infra: '--force looks like a flag' }),
    call(6, 'verify', { id: 12, decision: 'accept', note: 'proved' }),
    call(7, 'verify', { id: 12, decision: 'reject', note: 'failed', reason: 'TEST_FAILURE', cause: 'k', clause: '--sneaky clause' }),
    call(8, 'resume', {}),
    call(9, 'show_item', { id: 12 }),
    call(10, 'item_slice', { id: 12 }),
  ]);
  assert.deepEqual(calls.slice(1).map(entry => entry.argv), [
    ['next', '--json'],
    ['next', '--json', '--verify'],
    ['claim', '--json', '--', '12'],
    ['submit', '--json', '--', '12'],
    ['submit', '--json', '--infra=--force looks like a flag', '--', '12'],
    ['verify', '--json', '--note=proved', '--', '12', 'accept'],
    ['verify', '--json', '--note=failed', '--reason=TEST_FAILURE', '--cause=k', '--clause=--sneaky clause', '--', '12', 'reject'],
    ['resume', '--json'],
    ['show', '--json', '--', '12'],
    ['map', '--json', '--for=12'],
  ]);
  assert.ok(replies.every(reply => reply.result.isError === false));
  assert.ok(calls.every(entry => entry.context.cwd === '/seat' && entry.context.personChannel === 'mcp'), 'every call carries the mcp channel so the CLI refuses person moves too');
  assert.equal(JSON.parse(replies[0].result.content[0].text).version, 1);
});

test('MCP returns a CLI refusal as the tool result flagged isError, with the CLI document intact [A9,P6]', async () => {
  const refusal = { version: 1, error: { code: 'NOT_YOURS', message: 'held by another seat', next: 'run next' } };
  const { replies } = await serve(seated({ claim: () => ({ status: 1, document: refusal }) }), [call(1, 'claim', { id: 3 })]);
  assert.equal(replies[0].result.isError, true);
  assert.deepEqual(replies[0].result.structuredContent, refusal);
});

test('MCP shouts as its agent and captures an idea as a coordinator shout with kind idea [A9]', async () => {
  const { calls } = await serve(seated(), [
    call(1, 'shout', { to: 'view', text: 'hello' }),
    call(2, 'shout', { to: 'coordinator', text: 'stuck', kind: 'blocker' }),
    call(3, 'capture_idea', { text: 'a thought' }),
    call(4, 'capture_idea', { text: '   ' }),
  ]);
  const argv = calls.slice(1).map(entry => entry.argv);
  assert.deepEqual(argv[0], ['shout', '--json', '--', 'view', 'hello']);
  assert.deepEqual(argv[1], ['shout', '--kind=blocker', '--json', '--', 'coordinator', 'stuck']);
  assert.deepEqual(argv[2], ['shout', '--kind=idea', '--json', '--', 'coordinator', 'idea: a thought']);
  assert.deepEqual(argv[3], ['shout', '--kind=idea', '--json', '--', 'coordinator', '   '], 'blank text goes through unprefixed so the CLI refuses it');
});

test('MCP board_status joins status, list and the shared person-needs list, and stops at the first refusal [A9,N26]', async () => {
  const board = seated({
    status: () => ({ status: 0, document: { version: 1, agent: 'core-1', unread: 2 } }),
    list: () => ({ status: 0, document: { version: 1, items: [{ id: 1 }] } }),
  });
  const { replies, calls } = await serve(board, [call(1, 'board_status', {})]);
  assert.deepEqual(calls.slice(1).map(entry => entry.argv), [['status', '--json'], ['list', '--json']]);
  assert.deepEqual(replies[0].result.structuredContent, {
    version: 1, agent: 'core-1', unread: 2, items: [{ id: 1 }], needsYou: [{ kind: 'decision', id: 'D1' }],
  });

  const refused = { version: 1, error: { code: 'NOT_JOINED', message: 'join first' } };
  const blocked = await serve(seated({ status: () => ({ status: 1, document: refused }) }), [call(1, 'board_status', {})]);
  assert.equal(blocked.replies[0].result.isError, true);
  assert.deepEqual(blocked.replies[0].result.structuredContent, refused);
  assert.deepEqual(blocked.calls.map(entry => entry.argv[0]), ['whoami', 'status'], 'list never ran after the refusal');
});

test('MCP reads code-map tools through the native reader and never the CLI, and refuses without one [A9,C7,D3]', async () => {
  const reads = [];
  const readCodeMap = async (cwd, name, input) => { reads.push([cwd, name, input]); return { version: 1, name }; };
  const served = await serve(seated(), [call(1, 'usages', { target: 'a.js#f' }), call(2, 'cell', { path: 'a.js' }), call(3, 'impact', { files: ['a.js'] })], { readCodeMap });
  assert.deepEqual(reads, [['/seat', 'usages', { target: 'a.js#f' }], ['/seat', 'cell', { path: 'a.js' }], ['/seat', 'impact', { files: ['a.js'] }]]);
  assert.deepEqual(served.calls.map(entry => entry.argv[0]), ['whoami']);

  const missing = await serve(seated(), [call(1, 'usages', { target: 'a.js' })]);
  assert.equal(missing.replies[0].result.structuredContent.error.code, 'BAD_REQUEST');
});

test('MCP turns a failing CLI command into an internal error naming the cause [A9]', async () => {
  const silent = async argv => {
    if (argv[0] === 'whoami') return { status: 0, document: { id: 'core-1', lane: 'core' } };
    throw new Error('boom');
  };
  const { replies } = await serve(silent, [call(1, 'resume', {})]);
  assert.equal(replies[0].error.code, -32603);
  assert.match(replies[0].error.message, /boom/u);
});

test('MCP serves messages one at a time in arrival order even when an earlier tool is slow [A9]', async () => {
  const order = [];
  const slow = seated({
    show: async () => { await new Promise(resolve => setImmediate(resolve)); order.push('show'); return { status: 0, document: { version: 1 } }; },
    resume: () => { order.push('resume'); return { status: 0, document: { version: 1 } }; },
  });
  const { replies } = await serve(slow, [call(1, 'show_item', { id: 1 }), call(2, 'resume', {})]);
  assert.deepEqual(order, ['show', 'resume']);
  assert.deepEqual(replies.map(reply => reply.id), [1, 2]);
});
