/** Drives the real CLI (stats --compare, next --build) and the authenticated dashboard API over a private native history and checks their windows and read-only behaviour end to end [R1,R2,N2,A2]. */
import { viewApiPorts } from '../../../view/index.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { refusalDocument } from '../../index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { main } from '../../tests/fixtures/native.js';
import { serveApi } from '../../../../packages/api/index.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import {
  compareFlowWindows,
  comparisonLines,
} from '../../../../packages/stats/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import {
  BASE,
  at,
  entries,
  fixture,
  idle,
} from '../../../../packages/store/tests/fixtures/stats/compare.js';

/** Capture the actual CLI with its injected observation clock and full JSON protocol. */
async function cli(root, clock, args) {
  let stdout = '', stderr = '';
  const code = await main(args, { cwd: root, clock,
    stdout: { isTTY: false, write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  return { code, stdout, stderr, data: args.includes('--json') ? JSON.parse(stdout) : null };
}

test('two adjacent event windows report every hand-computed figure and absolute change [R1,R2]', async t => {
  const box = fixture(t), before = box.history();
  const result = compareFlowWindows(before, { now: BASE + 120 * 60_000, windowMinutes: 60, complete: true });
  const previous = { since: at(0), until: at(60), landed: 2, observedSeats: 2, unmeasuredSeats: 0,
    agentHours: 2, idleHours: 72 / 60, idleShare: 72 / 120,
    idleReasonHours: { 'nothing-eligible': 0, held: 25 / 60, 'review-family': 20 / 60, 'main-red': 0, focus: 0, unknown: 27 / 60 },
    idleReasons: { 'nothing-eligible': 0, held: 25 / 120, 'review-family': 20 / 120, 'main-red': 0, focus: 0, unknown: 27 / 120 },
    agentHoursPerLanding: 1, stageHours: { build: 35 / 60, rework: 15 / 60, reviewWait: 30 / 60, review: 23 / 60, land: 16 / 60 },
    stageShares: { build: 35 / 119, rework: 15 / 119, reviewWait: 30 / 119, review: 23 / 119, land: 16 / 119 },
    unknownStageHours: 0, submissions: 3, submittedItems: 2, submitsPerItem: 1.5, rejections: 1,
    rejectRate: 1 / 3, coordinatorShouts: 4, shoutsPerLanding: 2 };
  const current = { since: at(60), until: at(120), landed: 1, observedSeats: 2, unmeasuredSeats: 0,
    agentHours: 2, idleHours: 90 / 60, idleShare: 90 / 120,
    idleReasonHours: { 'nothing-eligible': 45 / 60, held: 15 / 60, 'review-family': 0, 'main-red': 30 / 60, focus: 0, unknown: 0 },
    idleReasons: { 'nothing-eligible': 45 / 120, held: 15 / 120, 'review-family': 0, 'main-red': 30 / 120, focus: 0, unknown: 0 },
    agentHoursPerLanding: 2, stageHours: { build: 15 / 60, rework: 0, reviewWait: 15 / 60, review: 15 / 60, land: 15 / 60 },
    stageShares: { build: 1 / 4, rework: 0, reviewWait: 1 / 4, review: 1 / 4, land: 1 / 4 },
    unknownStageHours: 0, submissions: 1, submittedItems: 1, submitsPerItem: 1, rejections: 0,
    rejectRate: 0, coordinatorShouts: 1, shoutsPerLanding: 1 };
  assert.deepEqual(result.previous, previous);
  assert.deepEqual(result.current, current);
  /** These explicit expected windows are the hand calculation; every leaf delta must use the same units. */
  function differences(a, b) {
    return Object.fromEntries(Object.keys(a).filter(key => !['since', 'until'].includes(key)).map(key => [key,
      typeof a[key] === 'number' ? a[key] - b[key] : differences(a[key], b[key])]));
  }
  assert.deepEqual(result.change, differences(current, previous));
  assert.ok(store.listItems(box.board).every(row => row.item_status === 'open'), 'mutable rows intentionally contradict recorded landings');
  const json = await cli(box.root, box.clock, ['stats', '--window', '1h', '--compare', '--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(json.data.comparison, result);
  const text = await cli(box.root, box.clock, ['stats', '--window', '1h', '--compare']);
  assert.equal(text.code, 0, text.stderr);
  for (const line of comparisonLines(result)) assert.ok(text.stdout.includes(line), line);
  assert.deepEqual(box.history(), before, 'both formats are read-only and share the same event-only projection');
});

test('ordinary next records its structured observation but stats reads add no idle history [R2,N2]', async t => {
  const box = fixture(t, []);
  runFixtureGit(['add', '-A'], { cwd: box.root, stdio: 'pipe' });
  runFixtureGit(['-c', 'user.name=Stats fixture', '-c', 'user.email=stats@example.invalid', 'commit', '-qm', 'Seed private stats board'], { cwd: box.root, stdio: 'pipe' });
  const before = box.history();
  const result = await cli(box.root, box.clock, ['next', '--build', '--json']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.equal(result.data.error.code, 'NOTHING_FREE');
  const observed = box.history().filter(row => row.event_kind === 'next-idle');
  assert.equal(observed.length, 1, result.stdout + result.stderr);
  assert.equal(observed[0].event_by, 'coordinator');
  assert.deepEqual(JSON.parse(observed[0].event_detail), { ...idle('nothing-eligible'), model: 'unknown' });
  assert.deepEqual(box.history().slice(0, before.length), before);
  const added = box.history().slice(before.length);
  assert.deepEqual(added.map(row => row.event_kind), ['spec_approval_baseline', 'next-idle'],
    'the first writable CLI also records its ordinary immutable spec baseline');
  const anchor = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, encoding: 'utf8' });
  assert.equal(added[0].event_by, 'coordinator');
  assert.deepEqual(JSON.parse(added[0].event_detail), { version: 1, file: 'SPEC.md', anchor, rows: [], model: 'unknown' });
  const after = box.history();
  const stats = await cli(box.root, box.clock, ['stats', '--window', '1h', '--compare', '--json']);
  assert.equal(stats.code, 0, stats.stderr);
  assert.deepEqual(box.history(), after);
});

test('Dashboard API projects the same read-time windows from cached event history, including deltas [R1,R2,A2]', async t => {
  const box = fixture(t);
  let now = Date.parse(at(120)), builds = 0;
  const before = box.history();
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root: box.root, name: 'Comparison fixture' }],
    now: () => now, onStateBuild: () => { builds++; } });
  t.after(() => api.close());
  const url = new URL(api.url), headers = { 'x-pullboard-key': url.searchParams.get('k') };
  const route = `${url.origin}/api/v1/boards/${store.boardId(box.board)}/state`;
  const first = await fetchFresh(route, { headers });
  assert.equal(first.status, 200);
  const document = await first.json();
  const command = await cli(box.root, box.clock, ['stats', '--window', '2h', '--compare', '--json']);
  assert.equal(command.code, 0, command.stderr);
  assert.deepEqual(document.state.statsComparison, command.data.comparison);
  assert.equal(document.state.statsComparison.current.until, at(120));
  now = Date.parse(at(120)) + 20_000; // Item progress is shown by the minute, so a cached build serves reads inside one minute.
  const readAt = new Date(now).toISOString();
  const next = await fetchFresh(route, { headers });
  assert.equal(next.status, 200);
  const cached = await next.json();
  assert.equal(cached.state.observedAt, readAt);
  assert.deepEqual(cached.state.statsComparison, compareFlowWindows(before, { now, windowMinutes: 120, complete: true }),
    'read-time windows project from the same cached event prefix without another database scan');
  assert.equal(cached.state.statsComparison.current.until, readAt);
  now = Date.parse(at(120)) + 40_000;
  const deltaResponse = await fetchFresh(`${route}?since=${document.state.sequence}`, { headers });
  assert.equal(deltaResponse.status, 200);
  const delta = await deltaResponse.json();
  assert.deepEqual(delta.delta.replace.statsComparison, compareFlowWindows(before, { now, windowMinutes: 120, complete: true }),
    'a clock-only delta carries the new comparison despite the unchanged event sequence');
  assert.equal(builds, 1, 'comparison uses the existing snapshot build, not a second history read');
  assert.deepEqual(box.history(), before);
});
