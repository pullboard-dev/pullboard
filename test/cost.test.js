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
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { sessionSnapshot, sameUsageAnchor, usageDifference } from '../src/cost-session.js';
import { usageCheckpoint, recordClaudeCost } from '../src/cost-ledger.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';

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

test('an item records the tokens and cost its seats spent [N2]', () => {
  const box = helpers.project('true');
  assert.equal(box.run(box.web, 'join', 'web', '--model', 'fixture-claude').code, 0);
  const second = join(box.dir, 'second-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', second, 'HEAD');
  assert.equal(box.run(second, 'join', 'web', '--model', 'fixture-codex').code, 0);
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = store.openBoard(boardFile);
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
    store.addMilestone(board, { agentId: 'coordinator', name: 'Usage milestone', items: [id] });
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
  seatRun(box, box.web, claude, ['cost', 'record'], JSON.stringify({ session_id: claudeId, cost: { total_cost_usd: 0 } }));
  seatRun(box, box.web, claude, ['claim', String(id)]);
  const message = { id: 'native-message-one', model: 'fixture-claude', usage: { input_tokens: 100, output_tokens: 10 } };
  record(claudeFile, { type: 'assistant', message });
  record(claudeFile, { type: 'assistant', message }); // Stream repetition must not double charge.
  seatRun(box, box.web, claude, ['cost', 'record'], JSON.stringify({ session_id: claudeId, cost: { total_cost_usd: 0.25 } }));
  seatRun(box, box.web, claude, ['cost', 'refresh']);
  record(claudeFile, { type: 'system', subtype: 'tool-metadata', text: 'No provider usage changed' });
  seatRun(box, box.web, claude, ['release', String(id), '--no-next']);
  record(codexFile, { type: 'turn_context', payload: { model: 'fixture-codex' } });
  record(codexFile, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 50 } } } });
  seatRun(box, second, codex, ['claim', String(id)]);
  const report = { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 700, output_tokens: 70 } } } };
  record(codexFile, report);
  record(codexFile, report);
  seatRun(box, second, codex, ['cost', 'refresh']);
  seatRun(box, second, codex, ['release', String(id), '--no-next']);
  const shown = JSON.parse(box.run(box.repo, 'show', String(id), '--json').out);
  assert.equal(shown.cost.inputTokens, 300);
  assert.equal(shown.cost.outputTokens, 30);
  assert.equal(shown.cost.costUSD, null, 'Codex does not report dollars; total is explicitly incomplete');
  assert.equal(shown.cost.knownCostUSD, 0.25);
  assert.ok(shown.cost.wallMs >= 0);
  assert.deepEqual(shown.cost.models.sort(), ['fixture-claude', 'fixture-codex']);
  const costs = JSON.parse(box.run(box.repo, 'cost', '--json').out);
  assert.equal(costs.items.find((entry) => entry.item === id).inputTokens, 300);
  assert.equal(costs.lanes.find((entry) => entry.lane === 'web').inputTokens, 300);
  assert.equal(costs.milestones.find((entry) => entry.milestone === 'Usage milestone').outputTokens, 30);
  assert.equal(costs.models.find((entry) => entry.model === 'fixture-claude').inputTokens, 100);
  assert.equal(costs.models.find((entry) => entry.model === 'fixture-codex').inputTokens, 200);
  assert.equal(costs.models.find((entry) => entry.model === 'fixture-claude').knownCostUSD, 0.25);
  unlinkSync(claudeFile);
  seatRun(box, box.web, claude, ['claim', String(unknownId)]);
  seatRun(box, box.web, claude, ['release', String(unknownId), '--no-next']);
  const unknown = JSON.parse(box.run(box.repo, 'show', String(unknownId), '--json').out).cost;
  assert.equal(unknown.inputTokens, null);
  assert.equal(unknown.outputTokens, null);
  assert.equal(unknown.costUSD, null);
  assert.ok(unknown.wallMs >= 0);
  assert.ok(unknown.models.length > 0, 'declared seat model survives unreadable provider records');
  assert.equal(JSON.parse(box.run(box.repo, 'show', String(id), '--json').out).cost.inputTokens, 300, 'recorded closed allocations survive transcript removal');
  const inspect = store.openBoard(boardFile);
  let publicRecords;
  try { publicRecords = JSON.stringify({ events: store.events(inspect), metadata: inspect.db.prepare('SELECT * FROM board_meta').all(), shown, costs }); }
  finally { store.closeBoard(inspect); }
  const stored = Buffer.concat([readFileSync(boardFile), ...(existsSync(boardFile + '-wal') ? [readFileSync(boardFile + '-wal')] : [])]);
  for (const secret of [claudeId, codexId, claudeFile, codexFile, 'native-message-one']) {
    assert.equal(stored.includes(Buffer.from(secret)), false, 'only sanitized summaries reach SQLite and its WAL');
    assert.equal(publicRecords.includes(secret), false, 'ordered event payloads, metadata, and public results are sanitized');
  }
});

test('an item records the tokens and cost its seats spent when a checkpoint fails [N2]', () => {
  const box = helpers.project('true');
  assert.equal(box.run(box.web, 'join', 'web', '--model', 'fixture-claude').code, 0);
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = store.openBoard(boardFile);
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
  seatRun(box, box.web, identity, ['cost', 'record'], JSON.stringify({ session_id: session, cost: { total_cost_usd: 0 } }));
  const ledger = join(box.repo, '.git', 'pullboard', 'cost-ledger.json');
  const saved = ledger + '.saved';
  renameSync(ledger, saved);
  mkdirSync(ledger); // Real private IO failure, after the primary board claim can commit.
  const env = { ...box.env, CLAUDE_CONFIG_DIR: join(box.dir, 'claude'), CODEX_HOME: join(box.dir, 'codex') };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_CI', 'CODEX_SHELL']) delete env[key];
  Object.assign(env, identity);
  const claimed = runFixtureChild(process.execPath, [helpers.BIN, 'claim', String(id)], { cwd: box.web, env, encoding: 'utf8' });
  const inspectClaim = store.openBoard(boardFile);
  try { assert.equal(store.getItem(inspectClaim, id).item_status, 'claimed', 'the primary claim really committed'); }
  finally { store.closeBoard(inspectClaim); }
  assert.equal(claimed.status, 0, `${claimed.stdout}${claimed.stderr}`);
  assert.match(claimed.stderr, /USAGE_PENDING/);
  rmSync(ledger, { recursive: true });
  renameSync(saved, ledger);
  seatRun(box, box.web, identity, ['cost', 'refresh']);
  record(file, { type: 'assistant', message: { id: 'work-one', model: 'fixture-claude', usage: { input_tokens: 100, output_tokens: 10 } } });
  seatRun(box, box.web, identity, ['cost', 'refresh']);
  record(file, { type: 'assistant', message: { id: 'work-two', model: 'fixture-claude', usage: { input_tokens: 5, output_tokens: 1 } } });
  const fail = store.openBoard(boardFile);
  try { fail.db.exec("CREATE TRIGGER fixture_usage_unavailable BEFORE INSERT ON event WHEN NEW.event_kind='usage' BEGIN SELECT RAISE(ABORT, 'fixture usage unavailable'); END"); }
  finally { store.closeBoard(fail); }
  const released = runFixtureChild(process.execPath, [helpers.BIN, 'release', String(id), '--no-next'], { cwd: box.web, env, encoding: 'utf8' });
  const inspectRelease = store.openBoard(boardFile);
  try {
    assert.equal(store.getItem(inspectRelease, id).item_status, 'open', 'the primary release really committed');
    inspectRelease.db.exec('DROP TRIGGER fixture_usage_unavailable');
  } finally { store.closeBoard(inspectRelease); }
  assert.equal(released.status, 0, `${released.stdout}${released.stderr}`);
  assert.match(released.stderr, /USAGE_PENDING/);
  assert.equal(JSON.parse(box.run(box.repo, 'show', String(id), '--json').out).cost.knownInputTokens, 100);
  seatRun(box, box.web, identity, ['cost', 'refresh']); // No active allocation remains: retry the closed summary.
  const cost = JSON.parse(box.run(box.repo, 'show', String(id), '--json').out).cost;
  assert.equal(cost.inputTokens, null, 'the missed private claim anchor remains unknown');
  assert.equal(cost.knownInputTokens, 105);
  assert.equal(cost.knownOutputTokens, 11);
  assert.ok(cost.wallMs >= 0);
  assert.deepEqual(cost.models, ['fixture-claude']);
  seatRun(box, box.web, identity, ['cost', 'refresh']);
  assert.equal(JSON.parse(box.run(box.repo, 'show', String(id), '--json').out).cost.knownInputTokens, 105, 'closed replay is idempotent');
});

test('an item records the tokens and cost its seats spent with a shared native session [N2]', () => {
  const box = helpers.project('true');
  assert.equal(box.run(box.web, 'join', 'web', '--model', 'fixture-codex').code, 0);
  const second = join(box.dir, 'overlap-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', second, 'HEAD');
  assert.equal(box.run(second, 'join', 'web', '--model', 'fixture-codex').code, 0);
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = store.openBoard(boardFile);
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
  const detail = () => JSON.parse(box.run(box.repo, 'show', String(first), '--json').out).cost;
  // A claim only opens its private anchor; the seat's next checkpoint publishes the measured interval.
  seatRun(box, box.web, identity, ['cost', 'refresh']);
  assert.equal(detail().inputTokens, 0);
  usage(150, 15);
  seatRun(box, second, identity, ['claim', String(last)]);
  const sharing = detail();
  assert.equal(sharing.shared, true, 'a peer’s shared record marks this item without impersonating this seat');
  assert.equal(sharing.inputTokens, null);
  usage(250, 25);
  seatRun(box, box.web, identity, ['cost', 'refresh']);
  usage(300, 30);
  seatRun(box, second, identity, ['release', String(last), '--no-next']);
  usage(320, 32);
  seatRun(box, box.web, identity, ['cost', 'refresh']);
  seatRun(box, box.web, identity, ['release', String(first), '--no-next']);
  const totals = JSON.parse(box.run(box.repo, 'cost', '--json').out);
  assert.equal(totals.sharedSessions.length, 1);
  const shared = totals.sharedSessions[0];
  assert.equal(shared.inputTokens, 150);
  assert.equal(shared.outputTokens, 15);
  assert.equal(shared.costUSD, null);
  const seats = [box.web, second].map((cwd) => JSON.parse(box.run(cwd, 'whoami', '--json').out).id).sort();
  assert.deepEqual(shared.seats.sort(), seats);
  const a = JSON.parse(box.run(box.repo, 'show', String(first), '--json').out).cost;
  const b = JSON.parse(box.run(box.repo, 'show', String(last), '--json').out).cost;
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
  seatRun(box, box.web, identity, ['cost', 'refresh']);
  assert.equal(JSON.parse(box.run(box.repo, 'cost', '--json').out).sharedSessions[0].inputTokens, 150, 'closed shared-session replay is idempotent');
});


test('an item records the tokens and cost its seats spent with a lagged native dollar hook [N2]', () => {
  const box = helpers.project('true');
  assert.equal(box.run(box.web, 'join', 'web', '--model', 'fixture-claude').code, 0);
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const ids = [];
  try {
    for (const title of ['Lagged dollars', 'Stale preclaim dollars']) ids.push(store.addItem(board, { by: 'coordinator', lane: 'web', title, specIds: ['G1'],
      criterion: 'stale provider dollars stay unknown', check: 'test -f web/ready',
      checkBaseline: { command: 'test -f web/ready', result: 'red', main: box.git(box.repo, 'rev-parse', 'HEAD'), seconds: 0 } }));
  } finally { store.closeBoard(board); }
  const session = 'lagged-private-session';
  const identity = { CLAUDE_CODE_SESSION_ID: session };
  const directory = join(box.dir, 'claude', 'projects', 'private-fixture');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${session}.jsonl`);
  writeFileSync(file, '');
  record(file, { type: 'assistant', message: { id: 'known-zero-before-claim', model: 'fixture-claude', usage: { input_tokens: 0, output_tokens: 0 } } });
  seatRun(box, box.web, identity, ['cost', 'record'], JSON.stringify({ session_id: session, cost: { total_cost_usd: 0 } }));
  seatRun(box, box.web, identity, ['claim', String(ids[0])]);
  record(file, { type: 'assistant', message: { id: 'spent-without-hook', model: 'fixture-claude', usage: { input_tokens: 100, output_tokens: 10 } } });
  seatRun(box, box.web, identity, ['release', String(ids[0]), '--no-next']);
  const first = JSON.parse(box.run(box.repo, 'show', String(ids[0]), '--json').out).cost;
  assert.equal(first.inputTokens, 100);
  assert.equal(first.costUSD, null, 'new native tokens without a new dollar report are unknown, never zero');
  seatRun(box, box.web, identity, ['claim', String(ids[1])]);
  record(file, { type: 'assistant', message: { id: 'new-item-spend', model: 'fixture-claude', usage: { input_tokens: 5, output_tokens: 1 } } });
  seatRun(box, box.web, identity, ['cost', 'record'], JSON.stringify({ session_id: session, cost: { total_cost_usd: 0.5 } }));
  seatRun(box, box.web, identity, ['release', String(ids[1]), '--no-next']);
  const second = JSON.parse(box.run(box.repo, 'show', String(ids[1]), '--json').out).cost;
  assert.equal(second.inputTokens, 5);
  assert.equal(second.costUSD, null, 'a stale claim-time cost baseline cannot charge historical provider spend');
  assert.equal(second.knownCostUSD, 0, 'no unsupported share of the native cumulative dollar report is attributed');
});


test('an item records the tokens and cost its seats spent after metadata-only appends [N2]', () => {
  const box = helpers.sandbox();
  const file = join(box.dir, 'native-session.jsonl');
  const source = { provider: 'claude', file };
  record(file, { type: 'assistant', message: { id: 'same-report', model: 'fixture-claude', usage: { input_tokens: 8, output_tokens: 2 } } });
  const report = sessionSnapshot(source);
  assert.deepEqual(usageDifference({ totals: {} }, report, 'fixture-claude'),
    [{ model: 'fixture-claude', inputTokens: null, outputTokens: null }],
    'a legacy empty-file anchor cannot backcharge the first readable provider record');
  record(file, { type: 'system', subtype: 'tool-metadata', text: 'No usage' });
  const metadata = sessionSnapshot(source, report);
  assert.ok(metadata, 'the original byte prefix remains intact');
  assert.equal(sameUsageAnchor(report, metadata, source), true, 'metadata-only appends retain the native dollar report');
  record(file, { type: 'assistant', message: { id: 'new-spend', model: 'fixture-claude', usage: { input_tokens: 1, output_tokens: 1 } } });
  const spent = sessionSnapshot(source, metadata);
  assert.equal(sameUsageAnchor(report, spent, source), false, 'new native usage cannot borrow a stale cost report');
  writeFileSync(file, '{}\n');
  assert.equal(sessionSnapshot(source, report), null, 'a truncated or rewritten prefix stays unknown');
  assert.equal(sameUsageAnchor(report, metadata, source), false, 'saved snapshots cannot authorize a rewritten source');
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
  /** Fixture statusline amounts are provider-shaped inputs, never estimated prices. */
  const dollars = amount => recordClaudeCost(info, { session_id: session, cost: { total_cost_usd: amount } }, environment);
  /** Exercise the actual durable overlap ledger at each allocation boundary. */
  const checkpoint = (agent, operation) => usageCheckpoint(info, { agent, item: agent === 'seat-a' ? 1 : 2,
    operation, model: 'fixture-claude', environment, now: Date.now() });
  dollars(0);
  checkpoint('seat-a', 'claim');
  record(file, { type: 'assistant', message: { id: 'solo-spend', model: 'fixture-claude', usage: { input_tokens: 10, output_tokens: 2 } } });
  dollars(0.1);
  checkpoint('seat-a', 'refresh');
  record(file, { type: 'system', subtype: 'tool-metadata', text: 'Only metadata precedes the overlap' });
  checkpoint('seat-b', 'claim');
  record(file, { type: 'assistant', message: { id: 'shared-spend', model: 'fixture-claude', usage: { input_tokens: 20, output_tokens: 4 } } });
  dollars(0.4);
  const group = checkpoint('seat-a', 'refresh').sharedSessions[0];
  assert.ok(group, 'the real ledger publishes one shared-session revision');
  assert.equal(group.records[0].inputTokens, 20);
  assert.equal(group.records[0].outputTokens, 4);
  assert.ok(Math.abs(group.records[0].knownCostUSD - 0.3) < Number.EPSILON, 'metadata preserves the shared dollar baseline');
  assert.equal(group.records[0].costUSD, group.records[0].knownCostUSD, 'the complete shared amount stays known');
  record(file, { type: 'system', subtype: 'tool-metadata', text: 'No new spend' });
  const repeated = checkpoint('seat-a', 'refresh').sharedSessions[0];
  assert.equal(repeated.records[0].costUSD, group.records[0].costUSD, 'metadata and retries never charge the shared spend twice');
});

test('an item records the tokens and cost its seats spent with an empty native usage file [N2]', () => {
  for (const provider of ['claude', 'codex']) {
    const box = helpers.project('true');
    const model = `fixture-${provider}`;
    assert.equal(box.run(box.web, 'join', 'web', '--model', model).code, 0);
    const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
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
    seatRun(box, box.web, identity, ['cost', 'refresh']);
    seatRun(box, box.web, identity, ['release', String(unknownId), '--no-next']);
    const unknown = JSON.parse(box.run(box.repo, 'show', String(unknownId), '--json').out).cost;
    assert.equal(unknown.inputTokens, null, `${provider}: readable empty input usage is unknown`);
    assert.equal(unknown.outputTokens, null, `${provider}: readable empty output usage is unknown`);
    assert.equal(unknown.costUSD, null, `${provider}: an empty file cannot establish dollars`);
    assert.ok(unknown.wallMs >= 0);
    assert.deepEqual(unknown.models, [model], 'declared model remains available without native usage');
    if (provider === 'claude') record(file, { type: 'assistant', message: { id: 'explicit-zero', model,
      usage: { input_tokens: 0, output_tokens: 0 } } });
    else {
      record(file, { type: 'turn_context', payload: { model } });
      record(file, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 0, output_tokens: 0 } } } });
    }
    seatRun(box, box.web, identity, ['claim', String(zeroId)]);
    seatRun(box, box.web, identity, ['release', String(zeroId), '--no-next']);
    const zero = JSON.parse(box.run(box.repo, 'show', String(zeroId), '--json').out).cost;
    assert.equal(zero.inputTokens, 0, `${provider}: actual native zero remains known`);
    assert.equal(zero.outputTokens, 0, `${provider}: actual native zero remains known`);
  }
});
