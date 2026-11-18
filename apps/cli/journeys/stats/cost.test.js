/** @pullboard-test-input apps/lib/src/logic/native.js */
/** Native provider records, private attribution, and shared item totals [N2]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { addMilestone } from '../../../../packages/store/index.js';
import {
  sessionSnapshot,
  usageDifference,
} from '../../../../packages/stats/index.js';
import { usageCheckpoint } from '../../../../packages/stats/index.js';
import { budgetState } from '../../../../packages/stats/index.js';
import { capacityLines } from '../../../../packages/stats/index.js';
import { readCapacity } from '../../../../packages/stats/index.js';
import { personBlockWords } from '../../../../packages/items/index.js';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { replayHistory } from '../../../../packages/stats/index.js';
import { projectAgentActivity } from '../../../../packages/store/index.js';
import { activityInterests } from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import {
  captureCommandInProcess,
  runCliInProcess,
} from '../../tests/fixtures/process.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { assertUsagePresentation } from '../../tests/fixtures/cockpit/usage.js';
import {
  cli$context as context,
  cli$ordered as ordered,
  whoAmI,
  withBoard,
} from '../../index.js';
import { publishUsage } from '../../../../packages/stats/index.js';
import * as nativeBoard from '../../../lib/src/logic/native.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';

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

/**
 * Exercise the real internal checkpoint in a joined fixture context; this is a contract control, not a public CLI command.
 * Why in process: the checkpoint is a library call, so a node -e child per call (seven per run) cost only its start-up; the seat environment is passed as publishUsage's environment option [C7,#10469].
 */
async function seatUsage(box, cwd, identity) {
  const env = { ...box.env, CODEX_HOME: join(box.dir, 'codex'), CLAUDE_CONFIG_DIR: join(box.dir, 'claude') };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_CI', 'CODEX_SHELL']) delete env[key];
  Object.assign(env, identity);
  const result = await captureCommandInProcess(async (_args, processIo) => {
    const io = { cwd: processIo.cwd, nativeBoard, say() {}, err(message) { processIo.stderr.write(message + '\n'); } };
    const ctx = context(io);
    await withBoard(ctx, board => publishUsage(ctx, board, { agent: whoAmI(ctx, board).id, operation: 'refresh' }, { ordered, environment: env }));
    return 0;
  }, [], { cwd, env });
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

test('cli.journeys-stats-cost.an-item-records-the-tokens-and: an item records the tokens and cost its seats spent [N2]', async () => {
  const box = await costProject('fixture-claude');
  const second = join(box.dir, 'second-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', second, 'HEAD');
  assert.equal((await fixtureJoin(box.runLocal, second, 'web', '--model', 'fixture-codex', '--route', 'strong')).code, 0);
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
  await seatUsage(box, box.web, claude);
  await seatRun(box, box.web, claude, ['claim', String(id)]);
  const message = { id: 'native-message-one', model: 'fixture-claude', usage: { input_tokens: 100, output_tokens: 10 } };
  record(claudeFile, { type: 'assistant', message });
  record(claudeFile, { type: 'assistant', message }); // Stream repetition must not double charge.
  await seatUsage(box, box.web, claude);
  await seatUsage(box, box.web, claude);
  record(claudeFile, { type: 'system', subtype: 'tool-metadata', text: 'No provider usage changed' });
  await seatRun(box, box.web, claude, ['release', String(id), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  record(codexFile, { type: 'turn_context', payload: { model: 'fixture-codex' } });
  record(codexFile, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 50 } } } });
  await seatRun(box, second, codex, ['claim', String(id)]);
  const report = { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 700, output_tokens: 70 } } } };
  record(codexFile, report);
  record(codexFile, report);
  await seatUsage(box, second, codex);
  await seatRun(box, second, codex, ['release', String(id), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  const shown = JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out);
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
  const costs = JSON.parse((await box.runLocal(box.repo, 'stats', '--json')).out).usage;
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
  await seatRun(box, box.web, claude, ['claim', String(unknownId)]);
  await seatRun(box, box.web, claude, ['release', String(unknownId), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
  const unknown = JSON.parse((await box.runLocal(box.repo, 'show', String(unknownId), '--json')).out).usage;
  assert.equal(unknown.inputTokens, null);
  assert.equal(unknown.outputTokens, null);
  assert.ok(unknown.unknownReasons.length > 0, 'unreadable native usage says why its counters are unknown');
  assert.equal(Object.hasOwn(unknown, 'costUSD'), false);
  assert.ok(unknown.wallMs >= 0);
  assert.ok(unknown.models.length > 0, 'declared seat model survives unreadable provider records');
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out).usage.inputTokens, 300, 'recorded closed allocations survive transcript removal');
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

test('cli.journeys-stats-cost.an-item-records-the-tokens-and-2: an item records the tokens and cost its seats spent after metadata-only appends [N2]', () => {
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


test('cli.journeys-stats-cost.an-item-records-the-tokens-and-3: an item records the tokens and cost its seats spent when metadata precedes a shared interval [N2]', () => {
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

test('cli.journeys-stats-cost.an-item-records-the-tokens-and-4: an item records the tokens and cost its seats spent with an empty native usage file [N2]', async () => {
  for (const provider of ['claude', 'codex']) {
    const model = `fixture-${provider}`;
    const box = await costProject(model);
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
    await seatRun(box, box.web, identity, ['claim', String(unknownId)]);
    await seatUsage(box, box.web, identity);
    await seatRun(box, box.web, identity, ['release', String(unknownId), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
    const unknown = JSON.parse((await box.runLocal(box.repo, 'show', String(unknownId), '--json')).out).usage;
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
    await seatRun(box, box.web, identity, ['claim', String(zeroId)]);
    await seatRun(box, box.web, identity, ['release', String(zeroId), '--reason', 'OTHER', '--note', 'Close the private usage fixture claim.', '--no-next']);
    const zero = JSON.parse((await box.runLocal(box.repo, 'show', String(zeroId), '--json')).out).usage;
    assert.equal(zero.inputTokens, 0, `${provider}: actual native zero remains known`);
    assert.equal(zero.outputTokens, 0, `${provider}: actual native zero remains known`);
  }
});

test('cli.journeys-stats-cost.usage-totals-use-existing-stats-and: usage totals use existing stats and show surfaces without a separate cost root [N2,A1]', async () => {
  const box = helpers.project('true');
  const result = await box.runLocal(box.repo, 'stats', '--json');
  assert.equal(result.code, 0, result.out);
  const document = JSON.parse(result.out);
  assert.ok(document.usage, 'stats exposes recorded usage alongside its existing proof counters');
  assert.deepEqual(Object.keys(document.usage).sort(), ['items', 'lanes', 'milestones', 'models', 'seats', 'sharedSessions'].sort());
  for (const values of Object.values(document.usage)) assert.deepEqual(values, [], 'a fresh board invents no usage');
  const separate = await box.runLocal(box.repo, 'cost', '--json');
  assert.notEqual(separate.code, 0, 'the small CLI has no separate cost command');
});

test('cli.journeys-stats-cost.a-budget-setting-is-optional-off: clause 1: a budget setting is optional, off by default and validated [N2]', () => {
  const fixture = privateFixtureFiles('pullboard-budget-setting-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = fixture.root;
  try {
    assert.equal(loadMachineSettings().budget, undefined, 'no budget unless one is set');
    fixture.write('settings.json', JSON.stringify({ budget: { dailyUsd: 5, totalUsd: 50 } }));
    assert.deepEqual(loadMachineSettings().budget, { dailyUsd: 5, totalUsd: 50 });
    for (const [budget, field] of [[{ dailyUsd: 0 }, 'budget.dailyUsd'], [{ totalUsd: -1 }, 'budget.totalUsd'], [{ dailyUsd: '5' }, 'budget.dailyUsd'], [{ weekUsd: 5 }, 'budget']]) {
      fixture.write('settings.json', JSON.stringify({ budget }));
      assert.throws(() => loadMachineSettings(), error => error.code === 'BAD_MACHINE_SETTINGS' && error.message.includes(field), `refuses ${JSON.stringify(budget)} naming ${field}`);
    }
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
  }
});

const model = 'm';

test('cli.journeys-stats-cost.a-budget-reads-ok-warn-at: clause 1: a budget reads ok, warn at 80 percent and stop at the limit [N2]', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  const now = Date.parse('2026-11-08T12:00:00Z');
  const put = (key, observedAt, outputTokens) => db.prepare('INSERT INTO board_meta VALUES(?,?)').run(key,
    JSON.stringify({ observedAt, shared: false, records: [{ model, inputTokens: 0, outputTokens }] }));
  // One dollar per output token, so spend reads straight off the token counts.
  const prices = { [model]: { output: 1_000_000 } };
  const board = { db };
  const board_ = (budget) => budgetState(board, prices, budget, now);
  put('cost:1:a', now - 86_400_000 * 2, 50);
  put('cost:2:a', now - 1000, 7);
  assert.deepEqual(board_({ dailyUsd: 10 }), { state: 'ok', spend: 7, limit: 10, which: 'dailyUsd' }, 'old days stay out of the daily spend');
  assert.equal(board_({ dailyUsd: 8 }).state, 'warn', '7 of 8 is above 80 percent');
  assert.equal(board_({ dailyUsd: 7 }).state, 'stop', 'spend at the limit stops');
  assert.deepEqual(board_({ dailyUsd: 100, totalUsd: 60 }), { state: 'warn', spend: 57, limit: 60, which: 'totalUsd' }, 'the total counts every day');
  assert.equal(board_({ dailyUsd: 7, totalUsd: 1000 }).state, 'stop', 'either limit stops');
});

test('cli.journeys-stats-cost.with-no-budget-set-budgetstate-returns: clause 2: with no budget set budgetState returns ok with no limit [N2]', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  db.prepare('INSERT INTO board_meta VALUES(?,?)').run('cost:1:a', JSON.stringify({ observedAt: 0, records: [{ model, inputTokens: 0, outputTokens: 5 }] }));
  assert.deepEqual(budgetState({ db }, { [model]: { output: 1_000_000 } }, undefined, Date.now()), { state: 'ok', spend: 5, limit: null, which: null });
  assert.equal(budgetState({ db }, { [model]: { output: 1_000_000 } }, {}, Date.now()).limit, null);
});

/** A joined seat with two open items and $110 of recorded spend priced at one dollar per token; settings.json is the machine file the claim reads. */
async function budgetFixture() {
  const model = 'fixture-claude';
  const box = await costProject(model);
  const ids = [];
  for (const title of ['Budget first', 'Budget second']) ids.push((await fileFixtureItem(box, box.repo, { lane: 'web', title, check: 'test -f web/ready' })).item_id);
  const claudeDir = join(box.dir, 'claude', 'projects', 'private-fixture');
  mkdirSync(claudeDir, { recursive: true });
  const claudeFile = join(claudeDir, 'budget-fixture.jsonl');
  writeFileSync(claudeFile, '');
  const claude = { CLAUDE_CODE_SESSION_ID: 'budget-fixture' };
  // A native baseline before the claim, so only the tokens spent after it are charged.
  record(claudeFile, { type: 'assistant', message: { id: 'budget-before-claim', model, usage: { input_tokens: 9, output_tokens: 1 } } });
  await seatUsage(box, box.web, claude);
  await seatRun(box, box.web, claude, ['claim', String(ids[0])]);
  record(claudeFile, { type: 'assistant', message: { id: 'budget-message', model, usage: { input_tokens: 100, output_tokens: 10 } } });
  await seatUsage(box, box.web, claude);
  const rate = 1_000_000;
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const limit = totalUsd => fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME,
    { costPrices: { [model]: { freshInput: rate, cacheReadInput: rate, cacheWriteInput: rate, output: rate } }, budget: { totalUsd } });
  const env = { ...box.env, CODEX_HOME: join(box.dir, 'codex'), CLAUDE_CONFIG_DIR: join(box.dir, 'claude'), ...claude };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_CI', 'CODEX_SHELL']) delete env[key];
  return { box, ids, claude, limit, run: args => runCliInProcess(args, { cwd: box.web, env }) };
}

test('cli.journeys-stats-cost.a-budget-at-stop-refuses-a: clause 1: a budget at stop refuses a new claim naming the spend, the limit and the next step [N2]', async () => {
  const fixture = await budgetFixture();
  // $110 recorded against a $50 total limit.
  fixture.limit(50);
  const refused = await fixture.run(['claim', String(fixture.ids[1])]);
  assert.notEqual(refused.status, 0, 'a new claim is refused at stop');
  const text = refused.stdout + refused.stderr;
  assert.match(text, /BUDGET_STOP/u);
  assert.match(text, /\$110\.00/u, 'the refusal names the spend');
  assert.match(text, /\$50\.00/u, 'the refusal names the limit');
  assert.match(text, /budget\.totalUsd/u, 'the refusal names the next step');
  // With the limit raised the same claim goes through.
  fixture.limit(500);
  // The seat holds one claim at a time, so free the first before the second.
  const freed = await fixture.run(['release', String(fixture.ids[0]), '--reason', 'OTHER', '--note', 'Free the seat for the second budget claim.', '--no-next']);
  assert.equal(freed.status, 0, freed.stdout + freed.stderr);
  const allowed = await fixture.run(['claim', String(fixture.ids[1])]);
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
});

test('cli.journeys-stats-cost.an-item-already-claimed-still-renews: clause 2: an item already claimed still renews and releases when the budget is at stop [N2]', async () => {
  const fixture = await budgetFixture();
  fixture.limit(50);
  const renewed = await fixture.run(['claim', String(fixture.ids[0])]);
  assert.equal(renewed.status, 0, 'the held claim renews: ' + renewed.stdout + renewed.stderr);
  const released = await fixture.run(['release', String(fixture.ids[0]), '--reason', 'OTHER', '--note', 'Close the budget fixture claim.', '--no-next']);
  assert.equal(released.status, 0, 'the held claim releases: ' + released.stdout + released.stderr);
});

test('cli.journeys-stats-cost.a-budget-at-80-percent-shows: clause 1: a budget at 80 percent shows in the capacity report, with spend and limit, and no budget shows no line [N2]', () => {
  const fixture = privateFixtureFiles('pullboard-budget-report-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = fixture.root;
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  const now = Date.parse('2026-11-08T12:00:00Z');
  db.prepare('INSERT INTO board_meta VALUES(?,?)').run('cost:1:a', JSON.stringify({ observedAt: now - 1000, records: [{ model, inputTokens: 0, outputTokens: 7 }] }));
  // No proof counters: the report is the unavailable snapshot every reader still renders through capacityLines.
  const report = () => capacityLines(readCapacity({ db }, now, { currentProofCounters: () => null, proofCounter: () => null }));
  const budgetLine = lines => lines.filter(line => line.startsWith('Budget'));
  try {
    assert.deepEqual(budgetLine(report()), [], 'with no budget set the report has no budget line');
    const prices = { [model]: { output: 1_000_000 } };
    fixture.write('settings.json', JSON.stringify({ budget: { dailyUsd: 8 }, costPrices: prices }));
    assert.deepEqual(budgetLine(report()), ['Budget at 80 percent: $7.00 of the $8.00 daily limit.']);
    fixture.write('settings.json', JSON.stringify({ budget: { totalUsd: 7 }, costPrices: prices }));
    assert.deepEqual(budgetLine(report()), ['Budget reached: $7.00 of the $7.00 total limit.']);
    fixture.write('settings.json', JSON.stringify({ budget: { dailyUsd: 100 }, costPrices: prices }));
    assert.deepEqual(budgetLine(report()), [], 'below 80 percent the report has no budget line');
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
  }
});

test('cli.journeys-stats-cost.a-budget-at-80-percent-warns: clause 1: a budget at 80 percent warns in Needs you [N2]', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  const now = new Date('2026-11-08T12:00:00Z');
  db.prepare('INSERT INTO board_meta VALUES(?,?)').run('cost:1:a', JSON.stringify({ observedAt: now.getTime() - 1000, shared: false, records: [{ model, inputTokens: 0, outputTokens: 8 }] }));
  const prices = { [model]: { output: 1_000_000 } };
  const lines = budget => personBlockWords(join(tmpdir(), 'no-such-pullboard-common-dir'), now, budgetState({ db }, prices, budget, now.getTime()));
  const warn = lines({ dailyUsd: 10 });
  assert.equal(warn.length, 1, 'one budget line at 80 percent');
  assert.equal(warn[0].code, 'BUDGET_WARN');
  assert.match(warn[0].reason, /\$8\.00 of the \$10\.00 daily budget/u, 'names spend and limit');
  assert.equal(lines({ dailyUsd: 8 })[0].code, 'BUDGET_STOP', 'at the limit it reads stop');
  assert.deepEqual(lines({ dailyUsd: 100 }), [], 'below 80 percent shows none');
  assert.deepEqual(lines(undefined), [], 'with no budget set it shows none');
});
