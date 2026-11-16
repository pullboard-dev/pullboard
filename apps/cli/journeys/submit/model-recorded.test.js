/** A submit and each accept or reject verdict record the model their seat declared, by CLI, API and MCP [C7,#2093]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { apiHttpBox } from '../../tests/fixtures/api.js';
import { checkOutSubmitted } from '../../tests/fixtures/api.js';
import { commitWork } from '../../tests/fixtures/api.js';
import { FIXTURE_BRIEF } from '../../tests/fixtures/api.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/testkit.js';
import { FIXTURE_MODEL_EARLIER } from '../../tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { startFixtureLocalRunner } from '../../tests/fixtures/runner/local-start.js';
import { whenRunnerSettles } from '../../tests/fixtures/runner/local-start.js';
import { CLI_ENTRY } from '../../tests/fixtures/runner/entry.js';
import { stopFixtureLocalRunner } from '../../tests/fixtures/runner/local-stop.js';

const CLAUSE = 'Move it by URL';

/** One successful versioned CLI call on the served board's own checkouts, run in this process. */
async function served(box, cwd, ...args) {
  const ran = await runCliInProcess([...args, '--json'], { cwd, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  return JSON.parse(ran.stdout);
}

/** A served board with a builder and a verifier seat (each declaring a different model) and a boardless clone set to its URL. */
async function seatsFor(t) {
  const box = await apiHttpBox(t);
  // Nothing detached may write under the tree while the fixture removes it [P7,C7].
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'main-red-refresh.started'), String(Date.now()));
  Object.assign(box.env, { PULLBOARD_CLAIM_BEATER: '0', PULLBOARD_USAGE_CHECKPOINT: 'inline' });
  const clone = join(box.dir, 'studio');
  runFixtureGit(['clone', '-q', box.root, clone], { cwd: box.dir, env: box.env, stdio: 'pipe' });
  const machine = join(box.dir, 'studio-home');
  mkdirSync(machine);
  fixtureMachineSettings(machine, { gate: { localRunner: false } });
  startFixtureLocalRunner(box.env, box.root, { entry: CLI_ENTRY });
  const remote = (seat, ...args) => runCliInProcess(args,
    { cwd: clone, env: { ...box.env, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_AGENT: seat.agent } });
  const first = await served(box, box.root, 'worktree', 'app', '--model', FIXTURE_MODEL, '--family', 'codex');
  assert.equal((await remote(first, 'settings', 'board.url', box.origin)).status, 0);
  assert.equal((await remote(first, 'settings', 'board.token', '--', box.key)).status, 0);
  const local = (seat, ...args) => runCliInProcess(args, { cwd: seat.path, env: { ...box.env, PULLBOARD_AGENT: seat.agent } });
  const add = async title => (await served(box, box.root, 'add', 'app', title, '--specs', 'G1', '--criterion', CLAUSE, '--brief', FIXTURE_BRIEF)).item.item_id;
  /** A fresh builder and verifier, each declaring its own model: a builder holding an earlier accepted item may not commit another. */
  const pair = async () => ({
    builder: await served(box, box.root, 'worktree', 'app', '--model', FIXTURE_MODEL, '--family', 'codex'),
    verifier: await served(box, box.root, 'worktree', 'app', '--model', FIXTURE_MODEL_EARLIER, '--family', 'claude'),
  });
  return { box, pair, remote, local, add };
}

/** Run a body on the fixture, then stop the served board and its runner before the tree is removed. */
function onSeats(body) {
  return async t => {
    const seats = await seatsFor(t);
    try { await body(seats, t); } finally { stopFixtureLocalRunner(seats.box.env.PULLBOARD_MACHINE_HOME); await seats.box.api.close(); }
  };
}

/** Wait for the host runner to post the item's pulled gate receipt. */
function settled(seats, id) {
  return whenRunnerSettles(seats.box.env, async () => {
    const row = (await seats.box.call(`${seats.box.path}/state`)).document.state.items.find(entry => entry.id === id);
    return row.status === 'claimed' ? null : row;
  }, { deadlineMs: 60_000, what: `the served gate of #${id}` });
}

/** The model each of the item's recorded events carries, by event kind. */
function recordedModels(seats, id) {
  // @pullboard-board-file journey: read the model the served board's own event rows recorded.
  const db = new DatabaseSync(join(seats.box.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try {
    const found = {};
    for (const row of db.prepare('SELECT event_by, event_kind, event_detail FROM event WHERE item_id = ? ORDER BY event_id').all(id)) {
      found[row.event_kind] = { by: row.event_by, model: JSON.parse(row.event_detail).model };
    }
    return found;
  } finally { db.close(); }
}

/** Check the submit and the verdict events name the builder's and the verifier's declared models. */
function assertModels(seats, id, verdict, { builder, verifier }) {
  const found = recordedModels(seats, id);
  assert.equal(found.submit?.by, builder.agent, 'the builder submitted');
  assert.equal(found.submit?.model, FIXTURE_MODEL, 'the submit event records the builder seat model');
  assert.equal(found[verdict]?.by, verifier.agent, `the verifier gave the ${verdict}`);
  assert.equal(found[verdict]?.model, FIXTURE_MODEL_EARLIER, `the ${verdict} event records the verifier seat model`);
}

/** Drive one item from claim to a verdict with `run(seat, ...args)`, which returns a parsed result and fails on a nonzero exit. */
async function drive(seats, run, id, verdict) {
  const { builder, verifier } = seats.current = await seats.pair();
  await run(builder, 'claim', String(id));
  commitWork(seats.box, builder, id);
  await run(builder, 'submit', String(id));
  assert.equal((await settled(seats, id)).status, 'submitted', 'the host runner posted the pulled gate receipt');
  checkOutSubmitted(seats.box, builder, verifier);
  await run(verifier, 'next', '--verify');
  if (verdict === 'accept') await run(verifier, 'verify', String(id), 'accept', '--reason', 'CRITERION_MET', '--note', 'read the diff');
  else await run(verifier, 'verify', String(id), 'reject', '--reason', 'TEST_FAILURE', '--clause', CLAUSE, '--note', 'the clause is not met');
}

/** A CLI runner that asserts a zero exit and returns the parsed document. */
function ok(seats, how) {
  return async (seat, ...args) => {
    const ran = await seats[how](seat, ...args, '--json');
    assert.equal(ran.status, 0, `${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
    return ran.stdout.trim() ? JSON.parse(ran.stdout) : null;
  };
}

/** One MCP tool call as one seat: the server runs in this process over an input of handshake plus the call, and its reply is read back. */
async function mcpCall(seats, seat, name, args) {
  const lines = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture-client', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }];
  const ran = await runCliInProcess(['mcp'], { cwd: seat.path, env: { ...seats.box.env, PULLBOARD_AGENT: seat.agent }, input: lines.map(line => JSON.stringify(line)).join('\n') + '\n' });
  const reply = ran.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === 2);
  assert.ok(reply?.result && !reply.result.isError, `${name}: ${ran.stdout}${ran.stderr}`);
  return reply.result.structuredContent;
}

/** The same moves the CLI makes, as MCP tool calls. */
function mcpRunner(seats) {
  return async (seat, verb, ...args) => {
    const id = Number(args[0]);
    if (verb === 'claim' || verb === 'submit') return mcpCall(seats, seat, verb, { id });
    if (verb === 'next') return mcpCall(seats, seat, 'next', { verify: true });
    return mcpCall(seats, seat, 'verify', { id, decision: args[1], note: 'read the diff',
      ...(args[1] === 'reject' ? { reason: 'TEST_FAILURE', clause: CLAUSE } : { reason: 'CRITERION_MET' }) });
  };
}

test('a submit and each verdict record the declaring seat\'s model [C7,#2093]', { timeout: 280_000 }, // budget: hang ceiling for a served board, two runner gates per path and about forty calls, not a throughput claim.
onSeats(async (seats, t) => {
  await t.test('clause 1: pullboard submit from a seat joined with a model records that model on the submit event', async () => {
    const id = await seats.add('Local submit model');
    await drive(seats, ok(seats, 'local'), id, 'accept');
    const found = recordedModels(seats, id);
    assert.equal(found.submit?.by, seats.current.builder.agent);
    assert.equal(found.submit?.model, FIXTURE_MODEL);
  });

  await t.test('clause 2: pullboard verify accept and verify reject from a seat joined with a model each record that model on the verdict event', async () => {
    const accepted = await seats.add('Local accept model');
    await drive(seats, ok(seats, 'local'), accepted, 'accept');
    assertModels(seats, accepted, 'accept', seats.current);
    const rejected = await seats.add('Local reject model');
    await drive(seats, ok(seats, 'local'), rejected, 'reject');
    assertModels(seats, rejected, 'reject', seats.current);
  });

  await t.test('clause 3: the same submit and verdicts sent over the API (board.url set) and the MCP tool record the seat model too', async () => {
    for (const verdict of ['accept', 'reject']) {
      const id = await seats.add(`Remote ${verdict} model`);
      await drive(seats, ok(seats, 'remote'), id, verdict);
      assertModels(seats, id, verdict, seats.current);
    }
    const run = mcpRunner(seats);
    for (const verdict of ['accept', 'reject']) {
      const id = await seats.add(`MCP ${verdict} model`);
      await drive(seats, run, id, verdict);
      assertModels(seats, id, verdict, seats.current);
    }
  });
}));
