/** Event-derived proof numbers have the same data in text and versioned JSON [R1,R2,A1]. */
import { submitFixture } from './board-submit-fixture.js';
import assert from 'node:assert/strict';
import { runFixtureGit } from './fixture-child.js';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { proofStats } from '../src/stats.js';
import { serveApi } from '../src/api.js';
import { fetchFresh } from './http-fixture.js';

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
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { web: { owns: ['web/'] } } }));
  writeFileSync(join(root, 'PRACTICE.md'), '');
  let now = new Date('2026-10-08T12:00:00.000Z');
  const clock = { now: () => now };
  const board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
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
  store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'Fixture rejects the first attempt.', head: 'a'.repeat(40), digest: 'frozen', policy: 'any' });
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
    agentId: reviewer, decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH', note: 'the heading is missing',
    head: commit, digest: first.digest, policy: 'any',
  });
  setNow('2026-10-09T12:00:00.000Z');
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
  store.editItem(board, id, { agentId: 'coordinator', criterion: 'the heading is accessible', reason: 'the fixture corrects its criterion' });
  const corrected = store.refreeze(board, id, { agentId: 'coordinator', freeze });
  submitFixture(board, id, { agentId: builder, commit, tree });
  store.verify(board, id, {
    agentId: reviewer, decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH',
    note: 'the corrected criterion still fails\nThe accessible heading is absent.',
    head: commit, digest: corrected.after, policy: 'any',
  });
  return id;
}

test('[R1,R2,A1] stats JSON is versioned, text states the same proof numbers and neither records a move', async (t) => {
  const { root, board } = fixture(t);
  const before = store.events(board);
  const observationBefore = Date.now();
  const json = await run(root, ['stats', '--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(json.stderr, '');
  const observed = Date.parse(json.data.stats.flow.asOf);
  assert.ok(observed >= observationBefore && observed <= Date.now(), 'the CLI records its own observation clock');
  const expected = proofStats(board, { now: observed });
  assert.deepEqual(json.data, { version: 1, stats: expected, gateWaits: [] }, 'a board with no gated runs reports no gate waits (#836)');
  assert.deepEqual([expected.submissions, expected.rejections, expected.rejectionShare, expected.merged, expected.mergedWithoutAccept], [2, 1, 0.5, 1, 0]);
  const text = await run(root, ['stats']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /2 submissions · 1 rejections · 50\.0% sent back/u);
  assert.match(text.stdout, /1 items merged · 0 merged without an accept/u);
  assert.match(text.stdout, /3 agents · 1 family buckets: unknown \(3 agents,/u);
  assert.match(text.stdout, /agents: coordinator \(unknown\) \(unknown; \d+ moves\), review-1 \(unknown\) \(unknown; \d+ moves\), web-1 \(unknown\) \(unknown; \d+ moves\)/u);
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
  assert.deepEqual(json.data.stats, proofStats(board, { since: '2026-10-09', now: Date.parse(json.data.stats.flow.asOf) }));
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
  const api = await serveApi({ runCommand: main, projects: () => [{ root, name: 'Statistics fixture' }] });
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
  assert.deepEqual(document.state.proofStats, proofStats(board, { now: observed }));
  assert.deepEqual(command.data.stats, proofStats(board, { now: Date.parse(command.data.stats.flow.asOf) }));
  assert.deepEqual({ ...document.state.proofStats, flow: { ...document.state.proofStats.flow, asOf: command.data.stats.flow.asOf } },
    command.data.stats, 'the two observations retain every invariant field exactly');
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
  const digest = await run(root, ['digest', '--json']);
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
  assert.deepEqual(json.data.stats, proofStats(board, { now: clock.now().getTime() }));
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
