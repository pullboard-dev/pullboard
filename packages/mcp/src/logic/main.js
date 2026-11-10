/**
 * pullboard mcp: a local MCP server over stdio that lets an agent's own MCP client read the board, work the loop and
 * coordinate on it as that agent (A9), and never make a person's move (P6). It is newline-delimited
 * JSON-RPC 2.0 on stdin and stdout, hand-written because Pullboard has no dependencies, and it opens
 * no network connection (P5). Every tool runs the CLI command it mirrors through the same `main` the
 * terminal and the local API use, with its arguments as distinct argv entries after --, the form the
 * API's moveArgs builds, so a refusal reaches the client with the CLI's own code and next step.
 */
import { COORDINATOR } from "../../../config/index.js";
import { VERSION } from "../../../config/index.js";
import { Refused } from "../../../kernel/light.js";

/** MCP revisions this server speaks; the first is offered when a client asks for one it does not know. */
 const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

/** The channel every engine call carries, so the CLI's own person check refuses too (B26, P6). */
 const MCP_CHANNEL = 'mcp';

/**
 * Tool names that read as a person's own move: approving or declining rows, answering a decision,
 * signing off, accepting a check that already passes on main. Matched anywhere in the normalized name, so a client cannot reach one by renaming it.
 */
const PERSON_MOVE = /approv|declin|answer|sign_?off|decide|decision|check_?accept/u;

/** The tools this server offers: name, what it does, and its exact input schema. */
 const MCP_TOOLS = Object.freeze([
  {
    name: 'board_status',
    description: 'The board at a glance for this seat\'s agent: who you are, the open and active items, the review queue, unread shouts, and needsYou: the shared list of open person decisions, undecided pending and draft spec rows, and lane holds. Mirrors pullboard status and pullboard list. It builds the full board projection, so it is slower on large boards.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'show_item',
    description: 'One item in full: its criterion, the check and criterion frozen at claim, its verdicts and its thread. Mirrors pullboard show <id>.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'The item id, as on the board.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'item_slice',
    description: 'The code map slice for one item: its named files and functions, one hop out, and the tests that import them, stamped with main. Mirrors pullboard map --for <id>. Observations, not a complete call graph.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'The item id, as on the board.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'usages',
    description: 'Observed imports and calls for a committed module or module#function. Static observations, not a complete dynamic call graph.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false },
  },
  {
    name: 'impact',
    description: 'Dependent modules and the exact affected-tests selection for changed repository files at HEAD. Unknown edges remain named.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['files'], additionalProperties: false },
  },
  {
    name: 'cell',
    description: 'A committed file’s cell, front door and earlier cells it may import under the committed cells plan; temporary edges stay explicit.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'shout',
    description: 'Shout to a lane, an agent or all, as this seat\'s agent. Coordinator shouts require kind question, blocker, decision, exception or idea.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'A lane, an agent id, or all.' },
        text: { type: 'string', description: 'What to say.' },
        kind: { type: 'string', enum: ['question', 'blocker', 'decision', 'exception', 'idea'], description: 'Required when to is coordinator.' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'capture_idea',
    description: 'Capture an idea for the coordinator as a shout with --kind idea. Mirrors pullboard shout coordinator "idea: <text>" --kind idea.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The idea, in a sentence or two.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'next',
    description: 'Take the next item this seat can work, claiming it, or with verify the next review, reserving it. Mirrors pullboard next [--verify].',
    inputSchema: {
      type: 'object',
      properties: { verify: { type: 'boolean', description: 'Take the next review instead of the next item to build.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'claim',
    description: 'Claim an item, or renew this seat\'s claim on it; its criterion freezes at claim. Mirrors pullboard claim <id>.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'The item id, as on the board.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit',
    description: 'Submit this seat\'s committed work on an item: a clean tree, the gate green at HEAD. Mirrors pullboard submit <id> [--infra "<why>"].',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'The item id, as on the board.' },
        infra: { type: 'string', description: 'Why an existing test or gate file was edited, when submit asks for it.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'verify',
    description: 'Give a verdict on another agent\'s submitted item from its checked-out commit. Mirrors pullboard verify <id> accept --note "<how>" or reject --reason <CODE> --clause "<frozen wording>" --note "<what failed>".',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'The item id, as on the board.' },
        decision: { type: 'string', enum: ['accept', 'reject'], description: 'accept or reject.' },
        note: { type: 'string', description: 'How it was proved, or what failed.' },
        reason: { type: 'string', description: 'For a reject: the reason code, such as TEST_FAILURE.' },
        cause: { type: 'string', description: 'For a reject: the cause key, when one is known.' },
        clause: { type: 'string', description: 'For a reject: exact wording from the frozen criterion or spec row.' },
      },
      required: ['id', 'decision', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'resume',
    description: 'Pick this seat\'s work back up from the board: what it holds, what came back, and the one next step. Mirrors pullboard resume.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]);

/** The prefix that marks a captured idea in its shout, until ideas become their own kind of item. */
 const IDEA_PREFIX = 'idea: ';

/**
 * Check a tool's arguments against its input schema, refusing anything else.
 * Unknown fields are refused rather than ignored, so no argument can select a channel, a person or another seat.
 */
function validateArguments(tool, args) {
  const schema = tool.inputSchema;
  if (args === undefined) args = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Refused('BAD_REQUEST', `${tool.name} takes an object of arguments; use the tool's input schema`);
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw new Refused('BAD_REQUEST', `${tool.name} does not take ${key}; use only the arguments in its input schema`);
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) throw new Refused('BAD_REQUEST', `${tool.name} needs ${key}; use the tool's input schema`);
  }
  for (const [key, rule] of Object.entries(schema.properties)) {
    const value = args[key];
    if (value === undefined) continue;
    // Types only: a blank text or an id the board rejects reaches the CLI, so its own refusal comes back.
    if (rule.type === 'integer' && !Number.isSafeInteger(value)) {
      throw new Refused('BAD_REQUEST', `${tool.name} needs ${key} as a whole number; use the item id from the board`);
    }
    if (rule.type === 'string' && typeof value !== 'string') {
      throw new Refused('BAD_REQUEST', `${tool.name} needs ${key} as text; use the tool's input schema`);
    }
    if (rule.type === 'array' && (!Array.isArray(value) || !value.length || value.some(entry => typeof entry !== 'string'))) {
      throw new Refused('BAD_REQUEST', `${tool.name} needs ${key} as a nonempty list of repository paths; use the tool's input schema`);
    }
    if (rule.type === 'boolean' && typeof value !== 'boolean') {
      throw new Refused('BAD_REQUEST', `${tool.name} needs ${key} as true or false; use the tool's input schema`);
    }
    if (rule.enum && !rule.enum.includes(value)) {
      throw new Refused('BAD_REQUEST', `${tool.name} needs ${key} as one of ${rule.enum.join(', ')}; use the tool's input schema`);
    }
  }
  return args;
}

/** Normalize a tool name so case, dashes, dots and spaces cannot hide a person's move. */
function normalizedToolName(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
}

/**
 * Refuse a person's move outright, before any argument, header, environment or claimed identity is read.
 * P6: a person's own moves come only from the person, never through an agent interface such as MCP.
 */
export function refusePersonMove(name) {
  if (!PERSON_MOVE.test(normalizedToolName(name))) return;
  throw new Refused('HUMAN_REQUIRED', `${name} is a person's move; approving or declining rows, answering decisions, accepting checks and signing off come only from the person, never through MCP; ask your coordinator to bring it to the person, with the shout tool or pullboard shout coordinator --kind question --decision`);
}

/**
 * Run one CLI command in this seat's checkout through the CLI's own engine and return its one JSON document.
 * The channel is always mcp: the CLI's person check refuses any person move that could reach it.
 */
async function runCli(runCommand, cwd, argv) {
  let output = '';
  let diagnostics = '';
  const status = await runCommand(argv, {
    cwd,
    personChannel: MCP_CHANNEL,
    stdout: { isTTY: false, write: (text) => { output += text; } },
    stderr: { write: (text) => { diagnostics += text; } },
  });
  let document;
  try { document = JSON.parse(output); } catch {
    throw new Error(`pullboard ${argv[0]} printed no JSON document${diagnostics ? `: ${diagnostics.trim()}` : ''}`);
  }
  return { status, document };
}

/** The CLI argv for one loop move (next, claim, submit, verify, resume), or null for any other tool. */
function loopArgv(name, input) {
  if (name === 'next') return ['next', '--json', ...(input.verify ? ['--verify'] : [])];
  if (name === 'claim') return ['claim', '--json', '--', String(input.id)];
  if (name === 'submit') return ['submit', '--json', ...(input.infra === undefined ? [] : [`--infra=${input.infra}`]), '--', String(input.id)];
  if (name === 'verify') {
    return ['verify', '--json', `--note=${input.note}`, ...(input.reason === undefined ? [] : [`--reason=${input.reason}`]),
      ...(input.cause === undefined ? [] : [`--cause=${input.cause}`]),
      ...(input.clause === undefined ? [] : [`--clause=${input.clause}`]), '--', String(input.id), input.decision];
  }
  if (name === 'resume') return ['resume', '--json'];
  return null;
}

/** A tool result carrying one versioned document, flagged as an error when it is a refusal. */
function toolResult(document, isError) {
  return { content: [{ type: 'text', text: JSON.stringify(document, null, 2) }], structuredContent: document, isError };
}

/**
 * Run one tool through the CLI engine and return its MCP result.
 * Each read or move is the CLI command it mirrors; a nonzero status is that command's own refusal.
 */
async function callTool(runCommand, cwd, name, args, readCodeMap, readPersonNeeds) {
  refusePersonMove(name);
  const tool = MCP_TOOLS.find((entry) => entry.name === name);
  if (!tool) return null;
  const input = validateArguments(tool, args);
  if (['usages', 'impact', 'cell'].includes(name)) {
    if (!readCodeMap) throw new Refused('BAD_REQUEST', 'code-map reads need the native MCP command; restart pullboard mcp');
    return toolResult(await readCodeMap(cwd, name, input), false);
  }
  if (name === 'board_status') {
    const status = await runCli(runCommand, cwd, ['status', '--json']);
    if (status.status) return toolResult(status.document, true);
    const list = await runCli(runCommand, cwd, ['list', '--json']);
    if (list.status) return toolResult(list.document, true);
    // Shared projection retains unapplied row decisions, so settled questions never return as needs.
    const needsYou = readPersonNeeds(cwd);
    const { version, ...summary } = status.document;
    return toolResult({
      version,
      ...summary,
      items: list.document.items,
      needsYou,
    }, false);
  }
  if (name === 'item_slice') {
    const slice = await runCli(runCommand, cwd, ['map', '--json', `--for=${input.id}`]);
    return toolResult(slice.document, Boolean(slice.status));
  }
  if (name === 'show_item') {
    const shown = await runCli(runCommand, cwd, ['show', '--json', '--', String(input.id)]);
    return toolResult(shown.document, Boolean(shown.status));
  }
  // The loop's moves are the CLI's own argv: flags as --name=value, so no value can be read as another flag,
  // and positionals after --, so an id or decision cannot either (#961).
  const loop = loopArgv(name, input);
  if (loop) {
    const moved = await runCli(runCommand, cwd, loop);
    return toolResult(moved.document, Boolean(moved.status));
  }
  // The CLI's own shout argv, positionals after --, as moveArgs builds it. moveArgs refuses blank text
  // before the engine runs, so the text goes straight to the CLI, whose shout refuses it as EMPTY_SHOUT.
  const argv = name === 'shout'
    ? ['shout', ...(input.kind === undefined ? [] : [`--kind=${input.kind}`]), '--json', '--', input.to, input.text]
    : ['shout', '--kind=idea', '--json', '--', COORDINATOR, input.text.trim() ? `${IDEA_PREFIX}${input.text}` : input.text];
  const moved = await runCli(runCommand, cwd, argv);
  return toolResult(moved.document, Boolean(moved.status));
}

/** A JSON-RPC 2.0 error reply. */
function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/**
 * Answer one JSON-RPC message, or return null for a notification, which never gets a reply.
 * Refusals from a tool are tool results with isError; protocol faults are JSON-RPC errors.
 */
async function handleMessage(message, { runCommand, cwd, seat, readCodeMap, readPersonNeeds, formatRefusal }) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message && typeof message === 'object' && !Array.isArray(message) ? message.id : null, -32600, 'invalid request: send one JSON-RPC 2.0 object with a method');
  }
  const isNotification = !Object.hasOwn(message, 'id');
  if (isNotification) return null;
  const { id, method } = message;
  const params = message.params ?? {};
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: 'pullboard', version: VERSION },
      instructions: `Pullboard tools for ${seat}: read the board, show an item, shout, capture an idea, and work the loop: next, claim, submit, verify, resume. They run the CLI's own moves and refusals. A person's move (approving or declining rows, answering decisions, signing off) is refused HUMAN_REQUIRED here.`,
    } };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  if (method === 'tools/call') {
    if (!params || typeof params !== 'object' || typeof params.name !== 'string') return rpcError(id, -32602, 'tools/call needs params.name and params.arguments');
    try {
      const result = await callTool(runCommand, cwd, params.name, params.arguments, readCodeMap, readPersonNeeds);
      if (!result) {
        return rpcError(id, -32602, `unknown tool ${params.name}`, formatRefusal(new Refused('UNKNOWN_TOOL', `no tool ${params.name}; use one from tools/list`)));
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (error instanceof Refused) return { jsonrpc: '2.0', id, result: toolResult(formatRefusal(error), true) };
      return rpcError(id, -32603, `internal error: ${error.message}`);
    }
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

/**
 * Serve MCP on newline-delimited stdio until the client closes stdin. Messages are handled one at a
 * time, in order, because each tool runs one CLI command against the board. Only replies go to
 * output; anything diagnostic goes to log.
 *
 * @param {{ cwd: string, input: NodeJS.ReadableStream, output: { write(text: string): any }, log: { write(text: string): any }, runCommand: Function, readPersonNeeds: (cwd: string) => object[], formatRefusal: Function }} options
 * @returns {Promise<number>} the exit code
 */
export async function serveMcp({ cwd, input, output, log, runCommand, readCodeMap, readPersonNeeds, formatRefusal }) {
  if (typeof readPersonNeeds !== 'function') throw new Refused('BAD_REQUEST', 'MCP needs its native person-needs reader; start it with pullboard mcp');
  if (typeof formatRefusal !== 'function') throw new Refused('BAD_REQUEST', 'MCP needs its native refusal formatter; start it with pullboard mcp');
  const me = await runCli(runCommand, cwd, ['whoami', '--json']);
  const seat = me.status ? 'this checkout' : `agent ${me.document.id} in the ${me.document.lane} lane`;
  if (me.status) log.write(`pullboard mcp: ${me.document.error?.message ?? 'this checkout has no agent'}\nnext: ${me.document.error?.next ?? 'run pullboard join <lane> --model "<model name>"'}\n`);
  let queue = Promise.resolve();
  let buffer = '';
  /** Parse one line and queue its reply behind earlier messages. */
  const accept = (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let message;
      try { message = JSON.parse(line); } catch {
        output.write(`${JSON.stringify(rpcError(null, -32700, 'parse error: each line must be one JSON-RPC message'))}\n`);
        return;
      }
      const reply = await handleMessage(message, { runCommand, cwd, seat, readCodeMap, readPersonNeeds, formatRefusal });
      if (reply) output.write(`${JSON.stringify(reply)}\n`);
    }).catch((error) => { log.write(`pullboard mcp: ${error.stack ?? error.message}\n`); });
  };
  input.setEncoding?.('utf8');
  await new Promise((done, fail) => {
    input.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        accept(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    input.once('end', done);
    input.once('error', fail);
  });
  accept(buffer);
  await queue;
  return 0;
}
