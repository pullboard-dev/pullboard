import { testTimeBudget } from '../../../../packages/gate/index.js';
import { coordinatorActions } from '../../../../packages/stats/index.js';
import { viewApiPorts } from '../../../view/index.js';
/** Event-derived proof numbers have the same data in text and versioned JSON [R1,R2,A1]. */
import { apiBoardOpeners } from '../../tests/fixtures/board.js';

import { events as readStatsEvents } from '../../../../packages/store/index.js';
import { counterProofStats as readStatsCounter } from '../../../../packages/verify/index.js';
import {
  repositoryBoardFile,
  submitFixture,
} from '../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { existsSync } from 'node:fs';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { proofStats } from '../../../../packages/stats/index.js';
import { serveApi } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { boardHoldLog } from '../../../../packages/store/index.js';

/** Native read operations explicitly supplied to the statistics under test. */
const statsReadPorts = { events: readStatsEvents, counterProofStats: readStatsCounter };


/** Capture the real CLI without spawning a second model or changing the machine's registry. */
async function run(root, args, clock) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { cwd: root, ...(clock ? { clock } : {}),
    stdout: { isTTY: false, write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } } });
  return { code, stdout, stderr, data: args.includes('--json') ? JSON.parse(stdout) : null };
}

/** Create an isolated Git board with one rejected submission and accepted rework. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-stats-cli-')));
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'private-machine');
  t.after(() => {
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The disk board lives in a real repository with a committed policy, so submit seals it instead of refusing NO_POLICY [C7,V4].
  const boardFile = repositoryBoardFile(root);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { web: { owns: ['web/'] } } }));
  writeFileSync(join(root, 'PRACTICE.md'), '');
  runFixtureGit(['add', 'pullboard.json', 'PRACTICE.md'], { cwd: root, stdio: 'pipe' });
  runFixtureGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'fixture lanes'], { cwd: root, stdio: 'pipe' });
  let now = new Date('2026-10-08T12:00:00.000Z');
  const clock = { now: () => now };
  const board = openBoard(boardFile, clock);
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: root });
  const builder = store.register(board, { lane: 'web', path: join(root, 'web') });
  const reviewer = store.register(board, { lane: 'review', path: join(root, 'review') });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Proof fixture' });
  const freeze = () => ({ text: 'Proof fixture', digest: 'frozen' });
  const submit = (commit) => {
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
    submitFixture(board, id, { agentId: builder, commit, tree: 'b'.repeat(40) });
  };
  submit('a'.repeat(40));
  store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'Fixture rejects the first attempt.', clause: 'Proof fixture', head: 'a'.repeat(40), digest: 'frozen', policy: 'any' });
  submit('c'.repeat(40));
  store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', note: 'Fixture rework meets its bar.', head: 'c'.repeat(40), digest: 'frozen', policy: 'any' });
  store.merged(board, id, { agentId: 'coordinator', commit: 'd'.repeat(40) });
  return { root, board, builder, reviewer, setNow: (value) => { now = new Date(value); } };
}

/** Record two rejections of the same real board head after the criterion is corrected. */
function addCorrectedRepeat(board, builder, reviewer, setNow) {
  const commit = 'e'.repeat(40);
  const tree = 'f'.repeat(40);
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Corrected bar fixture', criterion: 'the heading is visible' });
  const freeze = (item) => ({ text: item.item_criterion, digest: `digest:${item.item_criterion}` });
  const first = store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
  submitFixture(board, id, { agentId: builder, commit, tree });
  store.verify(board, id, {
    agentId: reviewer, decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH', note: 'the heading is missing', clause: 'the heading is visible',
    head: commit, digest: first.digest, policy: 'any',
  });
  setNow('2026-10-09T12:00:00.000Z');
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
  store.editItem(board, id, { agentId: 'coordinator', criterion: 'the heading is accessible', reason: 'the fixture corrects its criterion' });
  const corrected = store.refreeze(board, id, { agentId: 'coordinator', freeze });
  submitFixture(board, id, { agentId: builder, commit, tree });
  store.verify(board, id, {
    agentId: reviewer, decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH',
    note: 'the corrected criterion still fails\nThe accessible heading is absent.', clause: 'the heading is accessible',
    head: commit, digest: corrected.after, policy: 'any',
  });
  return id;
}

test('[R1,R2,A1] stats JSON is versioned, text states the same proof numbers and neither records a move', async (t) => {
  const { root, board } = fixture(t);
  const before = store.events(board);
  const observationBefore = Date.now();
  assert.equal(existsSync(boardHoldLog()), false, 'this fixture owns a fresh private machine with no retained holds log');
  const json = await run(root, ['stats', '--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(json.stderr, '');
  const observed = Date.parse(json.data.stats.flow.asOf);
  assert.ok(observed >= observationBefore && observed <= Date.now(), 'the CLI records its own observation clock');
  const expected = proofStats(board, { now: observed }, statsReadPorts);
  // Landed #1875 adds machine-local hold evidence; #1056 adds explicit empty usage groups.
  const until = new Date(observed).toISOString();
  const boardHolds = { since: new Date(observed - 86_400_000).toISOString(), until, thresholdMs: 1000,
    count: null, today: until.slice(0, 10), todayCount: null, available: false, missing: true, truncated: false,
    invalidLines: 0, days: {}, commands: [],
    allowance: { version: 1, allowancePerDay: null, observedDay: null, fact: null, status: 'unmeasured' } };
  const usage = { items: [], lanes: [], milestones: [], models: [], seats: [], sharedSessions: [] };
  // Landed 1c6a65659d adds idle-filter seat minutes; a fresh machine reports no skipped rows.
  const idleSkips = { rows: [], since: boardHolds.since, until };
  const coordinator = coordinatorActions(board, { until });
  // The disk use under .git/pullboard is measured live, so check its shape here and the rest exactly [C7].
  const { disk, ...rest } = json.data;
  assert.equal(disk.total, disk.stores.reduce((sum, row) => sum + row.bytes, 0));
  assert.ok(disk.stores.some(row => row.name === 'board database'));
  assert.equal(disk.warning, null);
  assert.deepEqual(rest, { version: 1, stats: expected, coordinatorActions: coordinator, gateWaits: [], idleSkips, testWallBudgets: testTimeBudget([], observed), boardHolds, usage },
    'a fresh private machine reports no invented holds, usage or gated runs (#836,#1875,#1056)');
  assert.deepEqual([expected.submissions, expected.rejections, expected.rejectionShare, expected.merged, expected.mergedWithoutAccept], [2, 1, 0.5, 1, 0]);
  const text = await run(root, ['stats']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /2 submissions · 1 rejections · 50\.0% sent back/u);
  assert.match(text.stdout, /1 items merged · 0 merged without an accept/u);
  assert.match(text.stdout, /2 agents · 1 family buckets: unknown \(2 agents,/u);
  assert.match(text.stdout, /agents: review-1 \(unknown\) \(unknown; \d+ moves\), web-1 \(unknown\) \(unknown; \d+ moves\)/u);
  assert.ok(text.stdout.includes(expected.firstEventAt));
  assert.ok(text.stdout.includes(expected.lastEventAt));
  assert.match(text.stdout, /build: average 0 min · median 0 min · 1 measured/u);
  assert.match(text.stdout, /review: average unmeasured · median unmeasured · 0 measured; 1 of 1 completed items unmeasured/u);
  assert.match(text.stdout, /not enough measured flow to name a bottleneck \(1 items completed since the beginning, none with every stage measured\)/u);
  assert.match(text.stdout, /gate waits, last day: no gated runs recorded/u);
  assert.deepEqual(store.events(board), before, 'reading statistics appends no move');
});

test('[R2,A1] stats forwards the inclusive date window and returns an actionable invalid-date refusal', async (t) => {
  const { root, board } = fixture(t);
  const json = await run(root, ['stats', '--since', '2026-10-09', '--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(json.data.stats, proofStats(board, { since: '2026-10-09', now: Date.parse(json.data.stats.flow.asOf) }, statsReadPorts));
  assert.equal(json.data.stats.submissions, 0);
  assert.equal(json.data.stats.firstEventAt, null);
  const bad = await run(root, ['stats', '--since', '2026-02-30', '--json']);
  assert.equal(bad.code, 1);
  assert.equal(bad.data.version, 1);
  assert.equal(bad.data.error.code, 'BAD_SINCE');
  assert.match(bad.data.error.next, /--since 2026-10-08/u);
  const help = await run(root, ['stats', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--since <date>/u);
});

/** Exercise authenticated state from the same private board used by the command checks. */
test('[R1,R2,A2] local HTTP state exposes exactly the command statistics', async (t) => {
  const { root, board } = fixture(t);
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root, name: 'Statistics fixture' }] });
  t.after(() => api.close());
  const url = new URL(api.url);
  const headers = { 'x-pullboard-key': url.searchParams.get('k') };
  const response = await fetchFresh(`${url.origin}/api/v1/boards/${store.boardId(board)}/state`, { headers });
  assert.equal(response.status, 200);
  const document = await response.json();
  const command = await run(root, ['stats', '--json']);
  assert.equal(command.code, 0, command.stderr);
  assert.equal(document.version, 1);
  const observed = Date.parse(document.state.proofStats.flow.asOf);
  /** The public view keeps totals and grouped flow, while detailed CLI collections remain on demand. */
  const publicSummary = stats => {
    // notesPerSubmit and workFreeReleases are read only by pullboard stats, so the view state drops them (34682dda64, #6666).
    const { agents: _agents, bars: _bars, caught: _caught, notesPerSubmit: _notes, workFreeReleases: _releases, ...summary } = stats;
    const { items: _items, ...report } = summary.flow.report;
    return { ...summary, flow: { ...summary.flow, report } };
  };
  assert.deepEqual(document.state.proofStats, publicSummary(proofStats(board, { now: observed }, statsReadPorts)));
  for (const key of ['agents', 'bars', 'caught']) assert.equal(Object.hasOwn(document.state.proofStats, key), false);
  assert.equal(Object.hasOwn(document.state.proofStats.flow.report, 'items'), false);
  assert.deepEqual(command.data.stats, proofStats(board, { now: Date.parse(command.data.stats.flow.asOf) }, statsReadPorts));
  assert.deepEqual({ ...document.state.proofStats, flow: { ...document.state.proofStats.flow, asOf: command.data.stats.flow.asOf } },
    publicSummary(command.data.stats), 'the public projection retains every exposed command invariant exactly');
});

/** Add one catch of every other kind to the fixture board, through the events the board already records. */
function addCatches(board) {
  store.logEvent(board, 'coordinator', 'reopen', 1, { commit: 'c'.repeat(40), note: 'merge main', conflict: { files: ['web/app.js'], trunk: 'e'.repeat(40) }, cause: 'merge-conflict' });
  store.logEvent(board, 'coordinator', 'reopen', 1, { commit: 'c'.repeat(40), note: 'red', supersedes: 1, landingFailure: { batch: 'b1', tests: [{ file: 'test/a.test.js', name: 'adds up' }], mergeCommit: 'f'.repeat(40) } });
  store.logEvent(board, 'coordinator', 'flake-observation', null, { engine: 61, observation: { id: 'o1', classification: 'flake', file: 'test/b.test.js', name: 'waits' } });
  store.logEvent(board, 'coordinator', 'test-quarantine', 1, { engine: 67, file: 'test/c.test.js', name: 'same tree', tree: 'd'.repeat(40), runs: ['r1', 'r2'] });
  store.logEvent(board, 'sentinel', 'health-failure', 1, { key: 'k1', cause: 'refusal:STUCK', subject: 'item 1', engine: 1 });
}

test('[N26,D1] stats names what the board caught', async (t) => {
  const { root, board, builder, reviewer, setNow } = fixture(t);
  const repeatedId = addCorrectedRepeat(board, builder, reviewer, setNow);
  addCatches(board);
  const json = await run(root, ['stats', '--json']);
  assert.equal(json.code, 0, json.stderr);
  const { counts, total, entries } = json.data.stats.caught;
  assert.deepEqual(counts, { sentBack: 3, conflict: 1, redHead: 1, flake: 2, stuck: 1 });
  assert.equal(total, 8);
  assert.match(entries.find((entry) => entry.kind === 'sentBack').text, /Fixture rejects the first attempt\./u, 'a sent-back line carries the gap the reviewer named');
  assert.ok(entries.every((entry) => entry.at && Object.hasOwn(entry, 'item')), 'each catch names its item and when');
  const repeated = entries.filter((entry) => entry.kind === 'sentBack' && entry.item === repeatedId);
  assert.equal(repeated.length, 2, 'both persisted rejection events are shown');
  assert.match(repeated[0].text, /the heading is missing/u, 'the earlier event keeps its own reviewer note');
  assert.doesNotMatch(repeated[0].text, /corrected criterion/u);
  assert.match(repeated[1].text, /the corrected criterion still fails\nThe accessible heading is absent\./u, 'the raw note remains intact in JSON');
  const laterWindow = await run(root, ['stats', '--since', '2026-10-09', '--json']);
  const laterRepeat = laterWindow.data.stats.caught.entries.filter((entry) => entry.kind === 'sentBack' && entry.item === repeatedId);
  assert.equal(laterRepeat.length, 1, 'the later window excludes the earlier same-head rejection');
  assert.match(laterRepeat[0].text, /the corrected criterion still fails/u, 'the later event retains its note after earlier history is consumed');
  assert.doesNotMatch(laterRepeat[0].text, /the heading is missing/u);
  const text = await run(root, ['stats']);
  assert.match(text.stdout, /caught: 3 sent back by a reviewer · 1 conflicted with the trunk and went back for a merge · 1 heads the full suite refused to publish · 2 flakes proven · 1 stuck states the sentinel reported/u);
  assert.match(text.stdout, /sent back by a reviewer: #1, \S+: TEST_FAILURE: Fixture rejects the first attempt\./u);
  const repeatedLines = text.stdout.split(/\r?\n/u).filter((line) => line.startsWith(`  sent back by a reviewer: #${repeatedId},`));
  assert.equal(repeatedLines.length, 2, 'each repeated rejection renders on one physical line');
  assert.ok(repeatedLines.some((line) => line.includes('the heading is missing')));
  assert.ok(repeatedLines.some((line) => line.includes('the corrected criterion still fails The accessible heading is absent.')));
  assert.doesNotMatch(text.stdout, /^The accessible heading is absent\.$/mu, 'the multiline note does not leak into a second physical line');
  assert.match(text.stdout, /conflicted with the trunk and went back for a merge: #1, \S+: conflicted with the trunk in web\/app\.js/u);
  assert.match(text.stdout, /heads the full suite refused to publish: #1, \S+: the full suite failed test\/a\.test\.js: adds up/u);
  assert.match(text.stdout, /flakes proven: no item, \S+: test\/b\.test\.js: waits passed on rerun/u);
  assert.match(text.stdout, new RegExp(`flakes proven: #1, \\S+: test/c\\.test\\.js :: same tree went red and green on tree ${'d'.repeat(40)}`, 'u'), 'a test the board quarantined after one tree went red and green is a proven flake');
  assert.match(text.stdout, /stuck states the sentinel reported: #1, \S+: item 1 \(STUCK\)/u);
  // The fixture's events are dated 8-9 Oct 2026, so the 30-day digest window needs a clock beside them.
  const digest = await run(root, ['digest', '--json'], { now: () => new Date('2026-10-10T00:00:00.000Z') });
  assert.equal(digest.code, 0, digest.stderr);
  assert.match(digest.data.markdown, /## What the board caught, last 30 days/u);
  assert.match(digest.data.markdown, /3 sent back by a reviewer; 1 conflicted with the trunk/u);
  assert.match(digest.data.markdown, /Fixture rejects the first attempt\./u);
  const digestRows = digest.data.markdown.split(/\r?\n/u).filter((line) => line.startsWith(`- sent back by a reviewer: Corrected bar fixture (#${repeatedId}),`));
  assert.equal(digestRows.length, 2, 'each repeated rejection remains one digest row');
  assert.ok(digestRows.some((line) => line.includes('the heading is missing')));
  assert.ok(digestRows.some((line) => line.includes('the corrected criterion still fails The accessible heading is absent.')));
});

test('[N26,D1] the caught list never interrupts', async (t) => {
  const { root, board } = fixture(t);
  addCatches(board);
  const before = store.events(board);
  const shouts = board.db.prepare('SELECT count(*) AS n FROM shout').get().n;
  for (const args of [['status'], ['list'], ['inbox'], ['lanes']]) {
    const earlier = store.events(board);
    const out = await run(root, args);
    assert.doesNotMatch(out.stdout + out.stderr, /caught/iu, `pullboard ${args[0]} stays silent about catches`);
    const added = store.events(board).slice(earlier.length);
    assert.deepEqual(store.events(board).slice(0, earlier.length), earlier, `pullboard ${args[0]} leaves earlier history unchanged`);
    if (args[0] !== 'inbox') {
      assert.deepEqual(added, [], `pullboard ${args[0]} records no move for a catch`);
      continue;
    }
    // Inbox records its own delivery receipt; the first ordered move on a main checkout also records the spec baseline.
    assert.deepEqual(added.map(event => event.event_kind).sort(), ['activity-delivered', 'spec_approval_baseline'],
      'inbox records only its own delivery receipt and the one-time spec baseline');
    const delivery = JSON.parse(added.find(event => event.event_kind === 'activity-delivered').event_detail);
    assert.deepEqual(delivery.interrupts, [], 'the delivery receipt carries no catch');
    assert.ok(added.every(event => event.item_id === null), 'neither event names an item');
  }
  const afterOrdinary = store.events(board);
  await run(root, ['stats']);
  await run(root, ['digest']);
  assert.deepEqual(store.events(board), afterOrdinary, 'asking for the list records nothing');
  assert.equal(board.db.prepare('SELECT count(*) AS n FROM shout').get().n, shouts, 'a catch pushes no shout, banner or notification');
});


test('[R1,R2,A1] stats window exposes measured tails in text and JSON without recording moves', async t => {
  const { root, board } = fixture(t);
  const clock = { now: () => new Date('2026-10-08T13:00:00Z') };
  const before = store.events(board);
  const json = await run(root, ['stats', '--window', '6h', '--json'], clock);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(json.data.version, 1);
  assert.equal(json.data.window.durationMinutes, 360); // budget: declared --window 6h configuration, not a wall-clock measurement.
  assert.equal(json.data.window.landedItems, 1);
  assert.equal(json.data.window.stages.build.count, 1);
  assert.equal(json.data.window.stages.build.medianMinutes, 0, 'recorded instantaneous work is a measured zero');
  assert.equal(json.data.window.stages.review.medianMinutes, null, 'the fixture has no reservation evidence');
  assert.deepEqual(json.data.stats, proofStats(board, { now: clock.now().getTime() }, statsReadPorts));
  const text = await run(root, ['stats', '--window', '6h'], clock);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /flow window:.*1 landed/u);
  assert.match(text.stdout, /in review: 0 measured.*median unmeasured/u);
  assert.match(text.stdout, /#1: 0 min/u);
  const help = await run(root, ['stats', '--help']);
  assert.match(help.stdout, /--window <duration>/u);
  for (const duration of ['0h', '-1h', '6', 'forever', '999999999999999999999d']) {
    const bad = await run(root, ['stats', `--window=${duration}`, '--json'], clock);
    assert.equal(bad.code, 1);
    assert.equal(bad.data.error.code, 'USAGE');
    assert.match(bad.data.error.next, /--window 6h/u);
  }
  const ambiguous = await run(root, ['stats', '--window', '6h', '--since', '2026-10-08', '--json'], clock);
  assert.equal(ambiguous.code, 1);
  assert.equal(ambiguous.data.error.code, 'USAGE');
  assert.deepEqual(store.events(board), before);
});


test('[R1,R2,A1] stats window and ordinary counters share one SQLite snapshot while another seat appends', async t => {
  const { root, board } = fixture(t);
  const clock = { now: () => new Date('2026-10-08T13:00:00Z') };
  const original = DatabaseSync.prototype.exec;
  let injected = false;
  /** Append on a second real connection after the existing statistics snapshot is released. */
  DatabaseSync.prototype.exec = function (sql) {
    const result = original.call(this, sql);
    if (!injected && sql === 'RELEASE proof_stats_read') {
      injected = true;
      const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Concurrent landing' });
      store.logEvent(board, 'coordinator', 'merged', id, { commit: 'f'.repeat(40) });
    }
    return result;
  };
  let json;
  try { json = await run(root, ['stats', '--window', '6h', '--json'], clock); }
  finally { DatabaseSync.prototype.exec = original; }
  assert.equal(json.code, 0, json.stderr);
  assert.equal(injected, true, 'the separate writer committed at the recorded read boundary');
  assert.equal(json.data.stats.merged, 1);
  assert.equal(json.data.window.landedItems, 1, 'one response cannot combine old counters and a newer window');
  const next = await run(root, ['stats', '--window', '6h', '--json'], clock);
  assert.equal(next.data.stats.merged, 2);
  assert.equal(next.data.window.landedItems, 2, 'the next observation sees both committed receipts');
});

/**
 * Prove criterion clause 1: the shared board-submit fixture sets board.gitRoot itself, so the stats fixture's board is tied to its repository.
 */
test('clause 1: the shared board-submit fixture sets board.gitRoot to the fixture repository [C7,V4]', (t) => {
  const { root, board } = fixture(t);
  assert.equal(board.gitRoot, root, 'the board knows its repository without the case setting it');
});

/**
 * Prove criterion clause 2: the shared board-submit fixture seals the repository policy itself, so a submit is never refused NO_POLICY.
 * The fixture's own claim and submit would throw that refusal before returning if the board had no gitRoot policy.
 */
test('clause 2: no case in stats-cli, review-starve or next-verify is refused NO_POLICY by the board-submit fixture [C7,V4]', (t) => {
  const { board, builder } = fixture(t);
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Policy sealed fixture' });
  const freeze = () => ({ text: 'Policy sealed fixture', digest: 'frozen' });
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
  assert.doesNotThrow(() => submitFixture(board, id, { agentId: builder, commit: '1'.repeat(40), tree: '2'.repeat(40) }),
    error => error?.code === 'NO_POLICY');
  assert.equal(store.getItem(board, id).item_status, 'submitted', 'the fixture submit sealed the policy and reached submitted');
});
