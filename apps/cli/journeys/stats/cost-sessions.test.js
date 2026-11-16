/** @pullboard-test-input apps/lib/src/logic/native.js */
/** Session cost records: a failed checkpoint, a shared native session and a claim switch [N2]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { assertUsagePresentation } from '../../tests/fixtures/cockpit/usage.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Write one native-shaped JSONL record; fixture data is not claimed provider execution. */
function record(file, row) {
  appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...row }) + '\n');
}

/** Invoke the production CLI in process with one private provider identity, never the host's provider home. */
async function seatRun(box, cwd, identity, args, input) {
  const env = { ...box.env, CODEX_HOME: join(box.dir, 'codex'), CLAUDE_CONFIG_DIR: join(box.dir, 'claude') };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_CI', 'CODEX_SHELL']) delete env[key];
  Object.assign(env, identity);
  const result = await runCliInProcess(args, { cwd, env, input });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  return args.includes('--json') ? JSON.parse(result.stdout) : result.stdout;
}

/** Exercise the real internal checkpoint in a joined fixture context; this is a contract control, not a public CLI command. */
function seatUsage(box, cwd, identity) {
  const env = { ...box.env, CODEX_HOME: join(box.dir, 'codex'), CLAUDE_CONFIG_DIR: join(box.dir, 'claude') };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_CI', 'CODEX_SHELL']) delete env[key];
  Object.assign(env, identity);
  const cli = pathToFileURL(join(helpers.BIN, '../index.js')).href;
  const checkpoint = pathToFileURL(join(helpers.BIN, '../../../packages/stats/src/io/cost/checkpoint.js')).href;
  const code = `import {context,withBoard,whoAmI,cli\$ordered as ordered} from ${JSON.stringify(cli)};
    import {publishUsage} from ${JSON.stringify(checkpoint)};
    import * as nativeBoard from ${JSON.stringify(new URL('../../../lib/src/logic/native.js', import.meta.url).href)};
    const io={cwd:process.cwd(),nativeBoard,say(){},err(message){process.stderr.write(message+'\\n');}};
    const ctx=context(io);
    await withBoard(ctx,board=>publishUsage(ctx,board,{agent:whoAmI(ctx,board).id,operation:'refresh'},{ordered}));`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', code], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

/**
 * A project whose web seat joins with the model the case attributes usage to.
 * Why: the shared project already joins web-1 with the fixture model, and rejoining one seat with another model is refused ALREADY_JOINED (04384c0971).
 * The seat joins on the strong route: the model table maps these fixture names to mid, and the fixture items need strong (b95e1aa538).
 */
async function costProject(model) {
  const box = helpers.project('true', undefined, { withWorktree: false });
  const web = join(box.dir, 'web-1');
  box.git(box.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  assert.equal((await fixtureJoin(box.runLocal, web, 'web', '--model', model, '--route', 'strong')).code, 0);
  return { ...box, web };
}

test('clause 1: an item records the tokens and cost its seats spent when a checkpoint fails [N2]', async () => {
  const box = await costProject('fixture-claude');
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: the real CLI seats share this repository board file.
  const board = openBoard(boardFile);
  let id;
  try {
    id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Failed checkpoint fixture', specIds: ['G1'],
      criterion: 'a failed secondary checkpoint never reverses a recorded lifecycle move', check: 'test -f web/ready',
      checkBaseline: { command: 'test -f web/ready', result: 'red', main: box.git(box.repo, 'rev-parse', 'HEAD'), seconds: 0 } });
  } finally { store.closeBoard(board); }
  const session = 'cost-fault-private-session';
  const identity = { CLAUDE_CODE_SESSION_ID: session };
  const directory = join(box.dir, 'claude', 'projects', 'private-fixture');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${session}.jsonl`);
  record(file, { type: 'assistant', message: { id: 'anchor', model: 'fixture-claude', usage: { input_tokens: 0, output_tokens: 0 } } });
  seatUsage(box, box.web, identity);
  const ledger = join(box.repo, '.git', 'pullboard', 'cost-ledger.json');
  const saved = ledger + '.saved';
  renameSync(ledger, saved);
  mkdirSync(ledger); // Real private IO failure, after the primary board claim can commit.
  const env = { ...box.env, CLAUDE_CONFIG_DIR: join(box.dir, 'claude'), CODEX_HOME: join(box.dir, 'codex') };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_CI', 'CODEX_SHELL']) delete env[key];
  Object.assign(env, identity);
  const claimed = await runCliInProcess(['claim', String(id)], { cwd: box.web, env });
  // @pullboard-board-file journey: the real CLI seats share this repository board file.
  const inspectClaim = openBoard(boardFile);
  try { assert.equal(store.getItem(inspectClaim, id).item_status, 'claimed', 'the primary claim really committed'); }
  finally { store.closeBoard(inspectClaim); }
  assert.equal(claimed.status, 0, `${claimed.stdout}${claimed.stderr}`);
  assert.match(claimed.stderr, /USAGE_PENDING/);
  rmSync(ledger, { recursive: true });
  renameSync(saved, ledger);
  seatUsage(box, box.web, identity);
  record(file, { type: 'assistant', message: { id: 'work-one', model: 'fixture-claude', usage: { input_tokens: 100, output_tokens: 10 } } });
  seatUsage(box, box.web, identity);
  record(file, { type: 'assistant', message: { id: 'work-two', model: 'fixture-claude', usage: { input_tokens: 5, output_tokens: 1 } } });
  // @pullboard-board-file journey: the real CLI seats share this repository board file.
  const fail = openBoard(boardFile);
  try { fail.db.exec("CREATE TRIGGER fixture_usage_unavailable BEFORE INSERT ON event WHEN NEW.event_kind='usage' BEGIN SELECT RAISE(ABORT, 'fixture usage unavailable'); END"); }
  finally { store.closeBoard(fail); }
  const released = await runCliInProcess(['release', String(id), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next'], { cwd: box.web, env });
  // @pullboard-board-file journey: the real CLI seats share this repository board file.
  const inspectRelease = openBoard(boardFile);
  try {
    assert.equal(store.getItem(inspectRelease, id).item_status, 'open', 'the primary release really committed');
    inspectRelease.db.exec('DROP TRIGGER fixture_usage_unavailable');
  } finally { store.closeBoard(inspectRelease); }
  assert.equal(released.status, 0, `${released.stdout}${released.stderr}`);
  assert.match(released.stderr, /USAGE_PENDING/);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out).usage.knownInputTokens, 100);
  seatUsage(box, box.web, identity); // No active allocation remains: retry the closed summary.
  const cost = JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out).usage;
  assert.equal(cost.inputTokens, null, 'the missed private claim anchor remains unknown');
  assert.equal(cost.knownInputTokens, 105);
  assert.equal(cost.knownOutputTokens, 11);
  assert.ok(cost.wallMs >= 0);
  assert.deepEqual(cost.models, ['fixture-claude']);
  seatUsage(box, box.web, identity);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out).usage.knownInputTokens, 105, 'closed replay is idempotent');
});

test('clause 2: an item records the tokens and cost its seats spent with a shared native session [N2]', async () => {
  const box = await costProject('fixture-codex');
  const second = join(box.dir, 'overlap-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', second, 'HEAD');
  assert.equal((await fixtureJoin(box.runLocal, second, 'web', '--model', 'fixture-codex', '--route', 'strong')).code, 0);
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: the real CLI seats share this repository board file.
  const board = openBoard(boardFile);
  let first;
  let last;
  try {
    /** Historical red observations are fixture data, never fabricated executions. */
    const add = (title) => store.addItem(board, { by: 'coordinator', lane: 'web', title, specIds: ['G1'], criterion: 'shared usage is not split by guesswork', check: 'test -f web/ready',
      checkBaseline: { command: 'test -f web/ready', result: 'red', main: box.git(box.repo, 'rev-parse', 'HEAD'), seconds: 0 } });
    first = add('First shared item');
    last = add('Second shared item');
  } finally { store.closeBoard(board); }
  const directory = join(box.dir, 'codex', 'sessions', '2026', '10', '23');
  mkdirSync(directory, { recursive: true });
  const session = 'one-native-session-for-two-seats';
  const identity = { CODEX_THREAD_ID: session };
  const file = join(directory, `rollout-${session}.jsonl`);
  record(file, { type: 'turn_context', payload: { model: 'fixture-codex' } });
  /** Native cumulative counters make both solo and shared attribution observable. */
  const usage = (input, output) => record(file, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } } });
  usage(100, 10);
  await seatRun(box, box.web, identity, ['claim', String(first)]);
  /** Read the item's totals as show prints them for any reader of the board. */
  const detail = async () => JSON.parse((await box.runLocal(box.repo, 'show', String(first), '--json')).out).usage;
  // A claim only opens its private anchor; the seat's next checkpoint publishes the measured interval.
  seatUsage(box, box.web, identity);
  assert.equal((await detail()).inputTokens, 0);
  usage(150, 15);
  await seatRun(box, second, identity, ['claim', String(last)]);
  const sharing = await detail();
  assert.equal(sharing.splitByTime, true, 'a peer’s shared record splits this item’s share by claimed time without impersonating this seat');
  assert.equal(sharing.shared, false);
  usage(250, 25);
  seatUsage(box, box.web, identity);
  usage(300, 30);
  await seatRun(box, second, identity, ['release', String(last), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  usage(320, 32);
  seatUsage(box, box.web, identity);
  await seatRun(box, box.web, identity, ['release', String(first), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  const totals = JSON.parse((await box.runLocal(box.repo, 'stats', '--json')).out).usage;
  assert.equal(totals.sharedSessions.length, 1);
  const shared = totals.sharedSessions[0];
  assert.equal(shared.inputTokens, 150);
  assert.equal(shared.outputTokens, 15);
  assert.equal(Object.hasOwn(shared, 'costUSD'), false);
  const seats = (await Promise.all([box.web, second].map(async (cwd) => JSON.parse((await box.runLocal(cwd, 'whoami', '--json')).out).id))).sort();
  assert.deepEqual(shared.seats.sort(), seats);
  const a = JSON.parse((await box.runLocal(box.repo, 'show', String(first), '--json')).out).usage;
  const b = JSON.parse((await box.runLocal(box.repo, 'show', String(last), '--json')).out).usage;
  assert.equal(a.splitByTime, true);
  assert.equal(b.splitByTime, true);
  assert.equal(a.shared, false);
  assert.equal(b.shared, false);
  assert.equal(a.inputTokens + b.inputTokens, 220, '50 solo before overlap and 20 after, plus the shared 150 split once by claimed time');
  assert.ok(a.inputTokens >= 70, 'the first item keeps its own solo tokens');
  assert.equal(totals.models.find((row) => row.model === 'fixture-codex').knownInputTokens, 220, 'model known subtotal counts shared usage once');
  assert.equal(JSON.stringify({ totals, a, b }).includes(session), false);
  assert.equal(JSON.stringify({ totals, a, b }).includes(file), false);
  seatUsage(box, box.web, identity);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'stats', '--json')).out).usage.sharedSessions[0].inputTokens, 150, 'closed shared-session replay is idempotent');
  // @pullboard-board-file journey: inspect the actual CLI-written shared usage and presentation without changing its board.
  const presentation = openBoard(boardFile);
  try { assertUsagePresentation(store.events(presentation), first, { root: box.repo, agents: store.listAgents(presentation) }); } finally { store.closeBoard(presentation); }
});


test('clause 3: an item records the tokens and cost its seats spent across an actual claim switch without dollar output [N2]', async () => {
  const box = await costProject('fixture-claude');
  // @pullboard-board-file journey: the real CLI seats share this repository board file.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const ids = [];
  try {
    for (const title of ['First claim usage', 'Second claim usage']) ids.push(store.addItem(board, { by: 'coordinator', lane: 'web', title, specIds: ['G1'],
      criterion: 'native tokens follow the current claimed item', check: 'test -f web/ready',
      checkBaseline: { command: 'test -f web/ready', result: 'red', main: box.git(box.repo, 'rev-parse', 'HEAD'), seconds: 0 } }));
  } finally { store.closeBoard(board); }
  const session = 'lagged-private-session';
  const identity = { CLAUDE_CODE_SESSION_ID: session };
  const directory = join(box.dir, 'claude', 'projects', 'private-fixture');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${session}.jsonl`);
  writeFileSync(file, '');
  record(file, { type: 'assistant', message: { id: 'known-zero-before-claim', model: 'fixture-claude', usage: { input_tokens: 0, output_tokens: 0 } } });
  seatUsage(box, box.web, identity);
  await seatRun(box, box.web, identity, ['claim', String(ids[0])]);
  record(file, { type: 'assistant', message: { id: 'spent-without-hook', model: 'fixture-claude', usage: { input_tokens: 100, output_tokens: 10 } } });
  await seatRun(box, box.web, identity, ['release', String(ids[0]), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  const first = JSON.parse((await box.runLocal(box.repo, 'show', String(ids[0]), '--json')).out).usage;
  assert.equal(first.inputTokens, 100);
  assert.equal(Object.hasOwn(first, 'costUSD'), false, 'public usage has no dollar output');
  await seatRun(box, box.web, identity, ['claim', String(ids[1])]);
  record(file, { type: 'assistant', message: { id: 'new-item-spend', model: 'fixture-claude', usage: { input_tokens: 5, output_tokens: 1 } } });
  seatUsage(box, box.web, identity);
  await seatRun(box, box.web, identity, ['release', String(ids[1]), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  const second = JSON.parse((await box.runLocal(box.repo, 'show', String(ids[1]), '--json')).out).usage;
  assert.equal(second.inputTokens, 5);
  const splitTotals = JSON.parse((await box.runLocal(box.repo, 'stats', '--json')).out).usage;
  assert.equal(splitTotals.items.filter(row => ids.includes(row.item)).reduce((sum, row) => sum + row.inputTokens, 0), first.inputTokens + second.inputTokens, 'stats sums exactly the item-held token allocations');
  assert.equal(splitTotals.lanes.find(row => row.lane === 'web').inputTokens, 105);
  assert.equal(Object.hasOwn(second, 'costUSD'), false, 'private dollar anchors never become output in this item');
  assert.equal(Object.hasOwn(second, 'knownCostUSD'), false, 'private native dollar reports remain outside public usage');
});
