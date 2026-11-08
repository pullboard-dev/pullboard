/** @pullboard-test-input source-tree */
/** Native provider records, private attribution, and shared item totals [N2]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { openBoard } from '../apps/lib/index.js';
import { addMilestone } from '../src/board-milestones.js';
import { sessionSnapshot, usageDifference } from '../packages/stats/index.js';
import { usageCheckpoint } from '../packages/stats/index.js';
import { replayHistory } from '../packages/stats/index.js';
import { projectAgentActivity } from '../src/board-activity-feed.js';
import { activityInterests } from '../src/board-activity-feed.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { assertUsagePresentation } from './cockpit/usage-history-control.js';
import { fixtureJoin } from './testkit-fixture.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Write one native-shaped JSONL record; fixture data is not claimed provider execution. */
function record(file, row) {
  appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...row }) + '\n');
}

/** Invoke the real CLI with one private provider identity, never the host's provider home. */
function seatRun(box, cwd, identity, args, input) {
  const env = { ...box.env, CODEX_HOME: join(box.dir, 'codex'), CLAUDE_CONFIG_DIR: join(box.dir, 'claude') };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_CI', 'CODEX_SHELL']) delete env[key];
  Object.assign(env, identity);
  const result = runFixtureChild(process.execPath, [helpers.BIN, ...args], { cwd, env, input, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  return args.includes('--json') ? JSON.parse(result.stdout) : result.stdout;
}

/** Exercise the real internal checkpoint in a joined fixture context; this is a contract control, not a public CLI command. */
function seatUsage(box, cwd, identity) {
  const env = { ...box.env, CODEX_HOME: join(box.dir, 'codex'), CLAUDE_CONFIG_DIR: join(box.dir, 'claude') };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_CI', 'CODEX_SHELL']) delete env[key];
  Object.assign(env, identity);
  const cli = pathToFileURL(join(helpers.BIN, '../../src/cli.js')).href;
  const checkpoint = pathToFileURL(join(helpers.BIN, '../../packages/stats/src/shell/cost-checkpoint.js')).href;
  const code = `import {context,withBoard,whoAmI,ordered} from ${JSON.stringify(cli)};
    import {publishUsage} from ${JSON.stringify(checkpoint)};
    import * as nativeBoard from ${JSON.stringify(new URL('../apps/lib/index.js', import.meta.url).href)};
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
function costProject(model) {
  const box = helpers.project('true', undefined, { withWorktree: false });
  const web = join(box.dir, 'web-1');
  box.git(box.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  assert.equal(fixtureJoin(box.run, web, 'web', '--model', model, '--route', 'strong').code, 0);
  return { ...box, web };
}

test('an item records the tokens and cost its seats spent [N2]', () => {
  const box = costProject('fixture-claude');
  const second = join(box.dir, 'second-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', second, 'HEAD');
  assert.equal(fixtureJoin(box.run, second, 'web', '--model', 'fixture-codex', '--route', 'strong').code, 0);
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: the real CLI seats share this repository board file.
  const board = openBoard(boardFile);
  let id;
  let unknownId;
  try {
    // Historical claim baseline is fixture data; the named case is the actual proof being run.
    id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Usage fixture', specIds: ['G1'],
      criterion: 'native usage is attributed', check: 'test -f web/ready',
      checkBaseline: { command: 'test -f web/ready', result: 'red', main: box.git(box.repo, 'rev-parse', 'HEAD'), seconds: 0 } });
    unknownId = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Unknown usage fixture', specIds: ['G1'],
      criterion: 'unreadable usage stays unknown', check: 'test -f web/ready',
      checkBaseline: { command: 'test -f web/ready', result: 'red', main: box.git(box.repo, 'rev-parse', 'HEAD'), seconds: 0 } });
    addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Usage milestone', items: [id] });
  } finally { store.closeBoard(board); }
  const claudeDir = join(box.dir, 'claude', 'projects', 'private-fixture');
  const codexDir = join(box.dir, 'codex', 'sessions', '2026', '10', '23');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  const claudeId = 'cost-fixture-claude';
  const codexId = 'cost-fixture-codex';
  const claudeFile = join(claudeDir, `${claudeId}.jsonl`);
  const codexFile = join(codexDir, `rollout-${codexId}.jsonl`);
  writeFileSync(claudeFile, '');
  writeFileSync(codexFile, '');
  const claude = { CLAUDE_CODE_SESSION_ID: claudeId };
  const codex = { CODEX_THREAD_ID: codexId };
  record(claudeFile, { type: 'assistant', message: { id: 'before-claim', model: 'fixture-claude', usage: { input_tokens: 9, output_tokens: 1 } } });
  seatUsage(box, box.web, claude);
  seatRun(box, box.web, claude, ['claim', String(id)]);
  const message = { id: 'native-message-one', model: 'fixture-claude', usage: { input_tokens: 100, output_tokens: 10 } };
  record(claudeFile, { type: 'assistant', message });
  record(claudeFile, { type: 'assistant', message }); // Stream repetition must not double charge.
  seatUsage(box, box.web, claude);
  seatUsage(box, box.web, claude);
  record(claudeFile, { type: 'system', subtype: 'tool-metadata', text: 'No provider usage changed' });
  seatRun(box, box.web, claude, ['release', String(id), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  record(codexFile, { type: 'turn_context', payload: { model: 'fixture-codex' } });
  record(codexFile, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 50 } } } });
  seatRun(box, second, codex, ['claim', String(id)]);
  const report = { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 700, output_tokens: 70 } } } };
  record(codexFile, report);
  record(codexFile, report);
  seatUsage(box, second, codex);
  seatRun(box, second, codex, ['release', String(id), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  const shown = JSON.parse(box.run(box.repo, 'show', String(id), '--json').out);
  assert.equal(shown.usage.inputTokens, 300);
  assert.equal(shown.usage.outputTokens, 30);
  assert.equal(Object.hasOwn(shown.usage, 'costUSD'), false, 'dollars are not part of this item');
  assert.equal(Object.hasOwn(shown.usage, 'knownCostUSD'), false);
  assert.ok(shown.usage.wallMs >= 0);
  assert.deepEqual(shown.usage.models.sort(), ['fixture-claude', 'fixture-codex']);
  // @pullboard-board-file journey: verify public reporting does not append accounting or lifecycle moves.
  const beforeStats = openBoard(boardFile);
  let recordedBeforeStats;
  try { recordedBeforeStats = store.events(beforeStats); } finally { store.closeBoard(beforeStats); }
  const costs = JSON.parse(box.run(box.repo, 'stats', '--json').out).usage;
  // @pullboard-board-file journey: the same real board remains unchanged by a stats read.
  const afterStats = openBoard(boardFile);
  try { assert.deepEqual(store.events(afterStats), recordedBeforeStats, 'stats is a read, not an implicit usage checkpoint'); }
  finally { store.closeBoard(afterStats); }
  assert.equal(costs.items.find((entry) => entry.item === id).inputTokens, 300);
  assert.equal(costs.lanes.find((entry) => entry.lane === 'web').inputTokens, 300);
  assert.equal(costs.milestones.find((entry) => entry.milestone === 'Usage milestone').outputTokens, 30);
  assert.equal(costs.models.find((entry) => entry.model === 'fixture-claude').inputTokens, 100);
  assert.equal(costs.models.find((entry) => entry.model === 'fixture-codex').inputTokens, 200);
  assert.equal(Object.hasOwn(costs.models.find((entry) => entry.model === 'fixture-claude'), 'knownCostUSD'), false);
  unlinkSync(claudeFile);
  seatRun(box, box.web, claude, ['claim', String(unknownId)]);
  seatRun(box, box.web, claude, ['release', String(unknownId), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  const unknown = JSON.parse(box.run(box.repo, 'show', String(unknownId), '--json').out).usage;
  assert.equal(unknown.inputTokens, null);
  assert.equal(unknown.outputTokens, null);
  assert.ok(unknown.unknownReasons.length > 0, 'unreadable native usage says why its counters are unknown');
  assert.equal(Object.hasOwn(unknown, 'costUSD'), false);
  assert.ok(unknown.wallMs >= 0);
  assert.ok(unknown.models.length > 0, 'declared seat model survives unreadable provider records');
  assert.equal(JSON.parse(box.run(box.repo, 'show', String(id), '--json').out).usage.inputTokens, 300, 'recorded closed allocations survive transcript removal');
  // @pullboard-board-file journey: the real CLI seats share this repository board file.
  const inspect = openBoard(boardFile);
  let publicRecords;
  try {
    const events = store.events(inspect), accounting = events.filter(event => ['usage', 'shared-usage'].includes(event.event_kind));
    assert.ok(accounting.length > 0, 'real fixture checkpoints retained native ordered accounting events');
    assertUsagePresentation(events, id, { root: box.repo, agents: store.listAgents(inspect) });
    assert.ok(accounting.every(event => Number.isSafeInteger(JSON.parse(event.event_detail).item)), 'each per-item usage receipt carries its item identity');
    assert.ok(store.itemThread(inspect, id).every(entry => !['usage', 'shared-usage'].includes(entry.kind)), 'item history omits accounting without deleting native receipts');
    assert.ok(replayHistory(events).events.every(event => !['usage', 'shared-usage'].includes(event.event_kind)), 'offline lifecycle replay omits accounting');
    const agent = store.listAgents(inspect).find(row => row.agent_id === shown.item_built_by) ?? store.listAgents(inspect).find(row => row.agent_lane === 'web');
    const interests = activityInterests(agent, store.listItems(inspect), { at: new Date().toISOString() });
    const activity = projectAgentActivity({ agent, interests, events: accounting, shouts: [], changesForMain: () => [] });
    assert.deepEqual(activity.entries, [], 'accounting does not turn into user-facing activity');
    publicRecords = JSON.stringify({ events, metadata: inspect.db.prepare('SELECT * FROM board_meta').all(), shown, costs });
  }
  finally { store.closeBoard(inspect); }
  const stored = Buffer.concat([readFileSync(boardFile), ...(existsSync(boardFile + '-wal') ? [readFileSync(boardFile + '-wal')] : [])]);
  for (const secret of [claudeId, codexId, claudeFile, codexFile, 'native-message-one']) {
    assert.equal(stored.includes(Buffer.from(secret)), false, 'only sanitized summaries reach SQLite and its WAL');
    assert.equal(publicRecords.includes(secret), false, 'ordered event payloads, metadata, and public results are sanitized');
  }
});

test('an item records the tokens and cost its seats spent when a checkpoint fails [N2]', () => {
  const box = costProject('fixture-claude');
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
  const claimed = runFixtureChild(process.execPath, [helpers.BIN, 'claim', String(id)], { cwd: box.web, env, encoding: 'utf8' });
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
  const released = runFixtureChild(process.execPath, [helpers.BIN, 'release', String(id), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next'], { cwd: box.web, env, encoding: 'utf8' });
  // @pullboard-board-file journey: the real CLI seats share this repository board file.
  const inspectRelease = openBoard(boardFile);
  try {
    assert.equal(store.getItem(inspectRelease, id).item_status, 'open', 'the primary release really committed');
    inspectRelease.db.exec('DROP TRIGGER fixture_usage_unavailable');
  } finally { store.closeBoard(inspectRelease); }
  assert.equal(released.status, 0, `${released.stdout}${released.stderr}`);
  assert.match(released.stderr, /USAGE_PENDING/);
  assert.equal(JSON.parse(box.run(box.repo, 'show', String(id), '--json').out).usage.knownInputTokens, 100);
  seatUsage(box, box.web, identity); // No active allocation remains: retry the closed summary.
  const cost = JSON.parse(box.run(box.repo, 'show', String(id), '--json').out).usage;
  assert.equal(cost.inputTokens, null, 'the missed private claim anchor remains unknown');
  assert.equal(cost.knownInputTokens, 105);
  assert.equal(cost.knownOutputTokens, 11);
  assert.ok(cost.wallMs >= 0);
  assert.deepEqual(cost.models, ['fixture-claude']);
  seatUsage(box, box.web, identity);
  assert.equal(JSON.parse(box.run(box.repo, 'show', String(id), '--json').out).usage.knownInputTokens, 105, 'closed replay is idempotent');
});

test('an item records the tokens and cost its seats spent with a shared native session [N2]', () => {
  const box = costProject('fixture-codex');
  const second = join(box.dir, 'overlap-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', second, 'HEAD');
  assert.equal(fixtureJoin(box.run, second, 'web', '--model', 'fixture-codex', '--route', 'strong').code, 0);
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
  seatRun(box, box.web, identity, ['claim', String(first)]);
  /** Read the item's totals as show prints them for any reader of the board. */
  const detail = () => JSON.parse(box.run(box.repo, 'show', String(first), '--json').out).usage;
  // A claim only opens its private anchor; the seat's next checkpoint publishes the measured interval.
  seatUsage(box, box.web, identity);
  assert.equal(detail().inputTokens, 0);
  usage(150, 15);
  seatRun(box, second, identity, ['claim', String(last)]);
  const sharing = detail();
  assert.equal(sharing.shared, true, 'a peer’s shared record marks this item without impersonating this seat');
  assert.equal(sharing.inputTokens, null);
  usage(250, 25);
  seatUsage(box, box.web, identity);
  usage(300, 30);
  seatRun(box, second, identity, ['release', String(last), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  usage(320, 32);
  seatUsage(box, box.web, identity);
  seatRun(box, box.web, identity, ['release', String(first), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  const totals = JSON.parse(box.run(box.repo, 'stats', '--json').out).usage;
  assert.equal(totals.sharedSessions.length, 1);
  const shared = totals.sharedSessions[0];
  assert.equal(shared.inputTokens, 150);
  assert.equal(shared.outputTokens, 15);
  assert.equal(Object.hasOwn(shared, 'costUSD'), false);
  const seats = [box.web, second].map((cwd) => JSON.parse(box.run(cwd, 'whoami', '--json').out).id).sort();
  assert.deepEqual(shared.seats.sort(), seats);
  const a = JSON.parse(box.run(box.repo, 'show', String(first), '--json').out).usage;
  const b = JSON.parse(box.run(box.repo, 'show', String(last), '--json').out).usage;
  assert.equal(a.shared, true);
  assert.equal(b.shared, true);
  assert.equal(a.inputTokens, null);
  assert.equal(b.inputTokens, null);
  assert.equal(a.knownInputTokens, 70, '50 solo before overlap and 20 after; shared150 is not charged again');
  assert.equal(b.knownInputTokens, 0);
  assert.equal(shared.inputTokens + a.knownInputTokens + b.knownInputTokens, 220);
  assert.equal(totals.models.find((row) => row.model === 'fixture-codex').knownInputTokens, 220, 'model known subtotal counts shared usage once');
  assert.equal(JSON.stringify({ totals, a, b }).includes(session), false);
  assert.equal(JSON.stringify({ totals, a, b }).includes(file), false);
  seatUsage(box, box.web, identity);
  assert.equal(JSON.parse(box.run(box.repo, 'stats', '--json').out).usage.sharedSessions[0].inputTokens, 150, 'closed shared-session replay is idempotent');
  // @pullboard-board-file journey: inspect the actual CLI-written shared usage and presentation without changing its board.
  const presentation = openBoard(boardFile);
  try { assertUsagePresentation(store.events(presentation), first, { root: box.repo, agents: store.listAgents(presentation) }); } finally { store.closeBoard(presentation); }
});


test('an item records the tokens and cost its seats spent across an actual claim switch without dollar output [N2]', () => {
  const box = costProject('fixture-claude');
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
  seatRun(box, box.web, identity, ['claim', String(ids[0])]);
  record(file, { type: 'assistant', message: { id: 'spent-without-hook', model: 'fixture-claude', usage: { input_tokens: 100, output_tokens: 10 } } });
  seatRun(box, box.web, identity, ['release', String(ids[0]), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  const first = JSON.parse(box.run(box.repo, 'show', String(ids[0]), '--json').out).usage;
  assert.equal(first.inputTokens, 100);
  assert.equal(Object.hasOwn(first, 'costUSD'), false, 'public usage has no dollar output');
  seatRun(box, box.web, identity, ['claim', String(ids[1])]);
  record(file, { type: 'assistant', message: { id: 'new-item-spend', model: 'fixture-claude', usage: { input_tokens: 5, output_tokens: 1 } } });
  seatUsage(box, box.web, identity);
  seatRun(box, box.web, identity, ['release', String(ids[1]), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  const second = JSON.parse(box.run(box.repo, 'show', String(ids[1]), '--json').out).usage;
  assert.equal(second.inputTokens, 5);
  const splitTotals = JSON.parse(box.run(box.repo, 'stats', '--json').out).usage;
  assert.equal(splitTotals.items.filter(row => ids.includes(row.item)).reduce((sum, row) => sum + row.inputTokens, 0), first.inputTokens + second.inputTokens, 'stats sums exactly the item-held token allocations');
  assert.equal(splitTotals.lanes.find(row => row.lane === 'web').inputTokens, 105);
  assert.equal(Object.hasOwn(second, 'costUSD'), false, 'private dollar anchors never become output in this item');
  assert.equal(Object.hasOwn(second, 'knownCostUSD'), false, 'private native dollar reports remain outside public usage');
});


test('an item records the tokens and cost its seats spent after metadata-only appends [N2]', () => {
  const box = helpers.sandbox();
  const file = join(box.dir, 'native-session.jsonl');
  const source = { provider: 'claude', file };
  record(file, { type: 'assistant', message: { id: 'same-report', model: 'fixture-claude', usage: { input_tokens: 8, output_tokens: 2 } } });
  const report = sessionSnapshot(source);
  assert.deepEqual(usageDifference({ totals: {} }, report, 'fixture-claude'),
    [{ model: 'fixture-claude', freshInputTokens: null, cacheReadInputTokens: null, cacheWriteInputTokens: null, inputTokens: null, outputTokens: null }],
    'a legacy empty-file anchor cannot backcharge the first readable provider record');
  record(file, { type: 'system', subtype: 'tool-metadata', text: 'No usage' });
  const metadata = sessionSnapshot(source, report);
  assert.ok(metadata, 'the original byte prefix remains intact');
  assert.deepEqual(usageDifference(report, metadata, 'fixture-claude'), [{ model: 'fixture-claude', inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cacheReadInputTokens: null, cacheWriteInputTokens: null }], 'metadata-only appends add no native token spend');
  record(file, { type: 'assistant', message: { id: 'new-spend', model: 'fixture-claude', usage: { input_tokens: 1, output_tokens: 1 } } });
  const spent = sessionSnapshot(source, metadata);
  assert.deepEqual(usageDifference(report, spent, 'fixture-claude'), [{ model: 'fixture-claude', inputTokens: 1, outputTokens: 1, freshInputTokens: 1, cacheReadInputTokens: null, cacheWriteInputTokens: null }], 'only new native counts become spend');
  writeFileSync(file, '{}\n');
  assert.equal(sessionSnapshot(source, report), null, 'a truncated or rewritten prefix stays unknown');
  assert.equal(sessionSnapshot(source, metadata), null, 'saved snapshots cannot authorize a rewritten source');
});


test('an item records the tokens and cost its seats spent when metadata precedes a shared interval [N2]', () => {
  const box = helpers.project('true');
  const info = { commonDir: join(box.repo, '.git') };
  const session = 'shared-metadata-native-fixture';
  const environment = { CLAUDE_CODE_SESSION_ID: session, CLAUDE_CONFIG_DIR: join(box.dir, 'claude') };
  const directory = join(environment.CLAUDE_CONFIG_DIR, 'projects', 'private-fixture');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${session}.jsonl`);
  writeFileSync(file, '');
  /** Exercise the actual durable overlap ledger at each allocation boundary. */
  const checkpoint = (agent, operation) => usageCheckpoint(info, { agent, item: agent === 'seat-a' ? 1 : 2,
    operation, model: 'fixture-claude', environment, now: Date.now() });
  checkpoint('seat-a', 'claim');
  record(file, { type: 'assistant', message: { id: 'solo-spend', model: 'fixture-claude', usage: { input_tokens: 10, output_tokens: 2 } } });
  checkpoint('seat-a', 'refresh');
  record(file, { type: 'system', subtype: 'tool-metadata', text: 'Only metadata precedes the overlap' });
  checkpoint('seat-b', 'claim');
  record(file, { type: 'assistant', message: { id: 'shared-spend', model: 'fixture-claude', usage: { input_tokens: 20, output_tokens: 4 } } });
  const group = checkpoint('seat-a', 'refresh').sharedSessions[0];
  assert.ok(group, 'the real ledger publishes one shared-session revision');
  assert.equal(group.records[0].inputTokens, 20);
  assert.equal(group.records[0].outputTokens, 4);
  assert.equal(Object.hasOwn(group.records[0], 'costUSD'), false, 'the durable token ledger does not invent pricing');
  record(file, { type: 'system', subtype: 'tool-metadata', text: 'No new spend' });
  const repeated = checkpoint('seat-a', 'refresh').sharedSessions[0];
  assert.equal(repeated.records[0].inputTokens, group.records[0].inputTokens, 'metadata and retries never charge shared native input twice');
  assert.equal(repeated.records[0].outputTokens, group.records[0].outputTokens, 'metadata and retries never charge shared native output twice');
});

test('an item records the tokens and cost its seats spent with an empty native usage file [N2]', () => {
  for (const provider of ['claude', 'codex']) {
    const model = `fixture-${provider}`;
    const box = costProject(model);
    // @pullboard-board-file journey: the real CLI seats share this repository board file.
    const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
    let unknownId;
    let zeroId;
    try {
      /** Seed ordinary claimable items; the check baseline is fixture data, not a claimed gate run. */
      const add = title => store.addItem(board, { by: 'coordinator', lane: 'web', title, specIds: ['G1'],
        criterion: 'Native usage is reported truthfully.', check: 'test -f web/ready',
        checkBaseline: { command: 'test -f web/ready', result: 'red', main: box.git(box.repo, 'rev-parse', 'HEAD'), seconds: 0 } });
      unknownId = add('Empty native source');
      zeroId = add('Explicit native zero');
    } finally { store.closeBoard(board); }
    const session = `empty-usage-${provider}`;
    const directory = provider === 'claude' ? join(box.dir, 'claude', 'projects', 'private-fixture') : join(box.dir, 'codex', 'sessions');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, provider === 'claude' ? `${session}.jsonl` : `rollout-${session}.jsonl`);
    writeFileSync(file, '');
    const identity = provider === 'claude' ? { CLAUDE_CODE_SESSION_ID: session } : { CODEX_THREAD_ID: session };
    seatRun(box, box.web, identity, ['claim', String(unknownId)]);
    seatUsage(box, box.web, identity);
    seatRun(box, box.web, identity, ['release', String(unknownId), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
    const unknown = JSON.parse(box.run(box.repo, 'show', String(unknownId), '--json').out).usage;
    assert.equal(unknown.inputTokens, null, `${provider}: readable empty input usage is unknown`);
    assert.equal(unknown.outputTokens, null, `${provider}: readable empty output usage is unknown`);
    assert.equal(Object.hasOwn(unknown, 'costUSD'), false, `${provider}: public usage contains no dollar fields`);
    assert.ok(unknown.wallMs >= 0);
    assert.deepEqual(unknown.models, [model], 'declared model remains available without native usage');
    if (provider === 'claude') record(file, { type: 'assistant', message: { id: 'explicit-zero', model,
      usage: { input_tokens: 0, output_tokens: 0 } } });
    else {
      record(file, { type: 'turn_context', payload: { model } });
      record(file, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 0, output_tokens: 0 } } } });
    }
    seatRun(box, box.web, identity, ['claim', String(zeroId)]);
    seatRun(box, box.web, identity, ['release', String(zeroId), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
    const zero = JSON.parse(box.run(box.repo, 'show', String(zeroId), '--json').out).usage;
    assert.equal(zero.inputTokens, 0, `${provider}: actual native zero remains known`);
    assert.equal(zero.outputTokens, 0, `${provider}: actual native zero remains known`);
  }
});

test('usage totals use existing stats and show surfaces without a separate cost root [N2,A1]', () => {
  const box = helpers.project('true');
  const result = box.run(box.repo, 'stats', '--json');
  assert.equal(result.code, 0, result.out);
  const document = JSON.parse(result.out);
  assert.ok(document.usage, 'stats exposes recorded usage alongside its existing proof counters');
  assert.deepEqual(Object.keys(document.usage).sort(), ['items', 'lanes', 'milestones', 'models', 'seats', 'sharedSessions'].sort());
  for (const values of Object.values(document.usage)) assert.deepEqual(values, [], 'a fresh board invents no usage');
  const separate = box.run(box.repo, 'cost', '--json');
  assert.notEqual(separate.code, 0, 'the small CLI has no separate cost command');
});
