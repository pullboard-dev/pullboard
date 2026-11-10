import { viewApiPorts } from '../../../view/index.js';
/** Exact pipeline accounting over an imported native SQLite fixture [R1,R2,A1,A2,C7]. */
import { apiBoardOpeners } from '../../tests/fixtures/board.js';

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { main } from '../../tests/fixtures/native.js';
import {
  pipelineStats,
  pipelineLimit,
  pipelineLines,
  pipelinePerHour,
  pipelinePerHourLines,
} from '../../../../packages/stats/index.js';
import { serveApi } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';

/** Reviewer models whose families the per-hour verdicts group by. */
const ANTHROPIC_MODEL = 'claude-sonnet-5-5';
const OPENAI_MODEL = 'gpt-6';
const BASE = Date.parse('2026-10-01T00:00:00.000Z');
/** Private synthetic native admission identities; never used as production proof receipts. */
const admission = id => ({ submitAdmission: { id: String(id).padStart(8, '0') + '-0000-4000-8000-000000000000', commit: 'a'.repeat(40), tree: 'b'.repeat(40) } });

/** Preserve known event timestamps in a real Git repository and private SQLite board. */
function fixture(t, entries) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-pipeline-')));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { core: { owns: ['src/'] } } }));
  writeFileSync(join(root, 'PRACTICE.md'), '');
  const seed = openBoard(':memory:');
  store.register(seed, { lane: 'coordinator', path: root });
  for (let id = 1; id <= Math.max(...entries.map(entry => entry[2])); id += 1) store.addItem(seed, { by: 'coordinator', lane: 'core', title: `Pipeline ${id}` });
  const document = exportBoard(seed); store.closeBoard(seed);
  document.tables.event = entries.map(([seconds, kind, id, detail = {}], index) => ({
    event_id: index + 1, event_at: new Date(BASE + seconds * 1000).toISOString(), event_by: 'coordinator',
    event_kind: kind, item_id: id, event_detail: JSON.stringify(detail),
  }));
  document.tables.sqlite_sequence.find(row => row.name === 'event').seq = entries.length;
  // @pullboard-board-file persistence: the real CLI and HTTP server reopen this same SQLite fixture.
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  importBoard(board, document);
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  return { root, board, history: store.events(board) };
}

/** One fully bounded claim/submit/review/landing cycle with hand-computed durations. */
function cycle(id, start = 0) {
  return [[start, 'add', id, { title: `Pipeline ${id}`, lane: 'core' }], [start + 1, 'claim', id],
    [start + 11, 'renew', id, admission(id)], [start + 31, 'submit', id], [start + 61, 'reserve', id],
    [start + 101, 'accept', id], [start + 151, 'merged', id]];
}

/** Capture the real CLI's versioned output without changing its board or invoking a gate. */
async function command(root, args) {
  let stdout = '', stderr = '';
  const code = await main(args, { cwd: root, stdout: { isTTY: false, write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } });
  return { code, stdout, stderr };
}

test('pipeline exact stage times use native admission, reservation and merge boundaries [R1,R2,C7]', t => {
  const { history } = fixture(t, cycle(1));
  const report = pipelineStats(history);
  assert.deepEqual(report.items[0].stages, { claim: 10000, submit: 20000, reviewWait: 30000, review: 40000, landing: 50000 });
  assert.deepEqual(report.items[0].gaps, []);
  assert.equal(report.totals.submit.measuredMs, 20000);
  assert.equal(report.totals.submit.unmeasuredItems, 0);
  assert.equal(report.causes.unknown, 0);
  assert.deepEqual(report.unmeasuredGaps.map(gap => [gap.kind, gap.count, gap.durationMs]), [['unrecorded-attempts', null, null]]);
  assert.match(pipelineLines(report).join('\n'), /unmeasured unrecorded-attempts/u);
});

test('pipeline retains every recorded retry/reopen cause and unknown without prose inference [R1,R2,C7]', t => {
  const rows = cycle(1);
  rows.splice(3, 0, [12, 'renew', 1, { ...admission(2), cause: 'RUNNER_WAIT_DEADLINE' }]);
  rows.splice(7, 0, [102, 'reopen', 1, { cause: 'flake' }], [103, 'refreeze', 1],
    [104, 'reopen', 1, { cause: 'main-red' }], [105, 'reopen', 1, { conflict: { files: ['src/example.js'] } }],
    [106, 'reopen', 1, { cause: 'companion-wait' }], [107, 'reopen', 1, { cause: 'a-new-cause', note: 'runner wait main red flake' }],
    [108, 'reopen', 1, { code: 'RUNNER_INFRA_RETRY_EXHAUSTED' }], [109, 'reopen', 1, { code: 'ITEM_PATCH_CHANGED' }]);
  const { history } = fixture(t, rows);
  const report = pipelineStats(history);
  assert.deepEqual(report.causes, { 'runner-wait': 1, flake: 1, 'main-red': 1, 'bar-change': 1, conflict: 1, 'companion-wait': 1, 'test-failure': 0, 'host-busy': 0, other: 0, unknown: 3 });
  assert.equal(report.items[0].retries.length, 9);
  assert.match(pipelineLines(report).join('\n'), /unknown 3/u);
});

test('pipeline does not invent split times for historical submits or absent reservations [R1,R2,C7]', t => {
  const { history } = fixture(t, [[0, 'add', 1], [1, 'claim', 1], [5, 'renew', 1], [11, 'submit', 1], [31, 'accept', 1], [81, 'merged', 1]]);
  const report = pipelineStats(history);
  assert.deepEqual(report.items[0].stages, { claim: null, submit: null, reviewWait: null, review: null, landing: 50000 });
  assert.equal(report.totals.claim.measuredMs, 0);
  assert.equal(report.totals.claim.unmeasuredItems, 1);
  assert.match(report.items[0].gaps.map(gap => gap.reason).join('\n'), /cannot be separated/u);
});

test('pipeline last-N window follows landed events and leaves input history unchanged [R1,R2,C7]', t => {
  const entries = [...cycle(1), ...cycle(2, 200), [400, 'reopen', 1, { cause: 'flake' }]];
  const { history } = fixture(t, entries), before = JSON.stringify(history);
  const report = pipelineStats(history, { limit: 1 });
  assert.deepEqual(report.items.map(item => item.id), [2]);
  assert.equal(report.causes.flake, 0, 'post-landing events do not retroactively change a completed cycle');
  assert.equal(JSON.stringify(history), before);
  for (const value of [0, -1, 1.5, 'garbage', 1001]) assert.throws(() => pipelineLimit(value), { code: 'USAGE' });
});

test('pipeline real CLI and authenticated API expose identical read-only native projection [R1,R2,A1,A2]', async t => {
  const { root, board, history } = fixture(t, cycle(1));
  const cli = await command(root, ['stats', 'pipeline', '--limit', '20', '--json']);
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), { version: 1, pipeline: pipelineStats(history) });
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root, name: 'Pipeline fixture' }] });
  t.after(() => api.close());
  const url = new URL(api.url), headers = { 'x-pullboard-key': url.searchParams.get('k') };
  const response = await fetchFresh(`${url.origin}/api/v1/boards/${store.boardId(board)}/state`, { headers });
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.deepEqual(document.state.statsPipeline, JSON.parse(cli.stdout).pipeline);
  assert.deepEqual(store.events(board), history, 'both readers leave native events unchanged');
});


test('pipeline recorded lease expiry excludes open time and restores review wait [R1,R2,C7]', t => {
  const at = seconds => new Date(BASE + seconds * 1000).toISOString();
  const { history } = fixture(t, [[0, 'add', 1], [1, 'claim', 1, { leaseUntil: at(11) }],
    [21, 'claim', 1, { leaseUntil: at(200) }], [31, 'renew', 1, admission(1)], [51, 'submit', 1],
    [61, 'reserve', 1, { until: at(71) }], [81, 'reserve', 1, { until: at(200) }], [101, 'accept', 1], [151, 'merged', 1]]);
  assert.deepEqual(pipelineStats(history).items[0].stages, { claim: 20000, submit: 20000, reviewWait: 20000, review: 30000, landing: 50000 });
});


/** Hand-built native events at known offsets from BASE for the per-hour projection. */
function hourEvents(rows) {
  return rows.map(([seconds, kind, by, detail], index) => ({ event_id: index + 1, event_at: new Date(BASE + seconds * 1000).toISOString(),
    event_by: by, event_kind: kind, item_id: 1, event_detail: JSON.stringify(detail ?? {}) }));
}
const gate = green => ({ run: { kind: 'submit', green } });

test('clause 1: stats --window prints green submits, verdicts by reviewer family, items landed and the share bounced at each stage per hour [C7]', () => {
  const history = hourEvents([
    [10, 'gate-run', 'core-1', gate(true)], [20, 'gate-run', 'core-2', gate(true)], [30, 'gate-run', 'core-3', gate(false)],
    [40, 'gate-run', 'core-1', { run: { kind: 'landing', green: false } }],
    [50, 'accept', 'core-9', { model: ANTHROPIC_MODEL }], [60, 'accept', 'core-8', { model: OPENAI_MODEL }], [70, 'reject', 'core-9', { model: ANTHROPIC_MODEL }],
    [80, 'merged', 'coordinator'], [90, 'reopen', 'coordinator'], [100, 'claim', 'core-1'], [110, 'claim', 'core-2'],
    [120, 'release', 'core-1', { reason: 'Seat core-1 has no heartbeat for two minutes or more' }], [130, 'release', 'core-2', { reason: 'done' }],
    [-7200, 'gate-run', 'core-4', gate(true)], [4000, 'merged', 'coordinator'],
  ]);
  const report = pipelinePerHour(history, { now: BASE + 1800 * 1000, windowMinutes: 30 });
  assert.equal(report.greenSubmitsPerHour, 4, '2 green in 30 minutes is 4 an hour; a landing gate and an older run do not count');
  assert.equal(report.landedPerHour, 2);
  assert.deepEqual(report.verdictsPerHour, [{ family: 'anthropic', accept: 2, reject: 2 }, { family: 'openai', accept: 2, reject: 0 }]);
  assert.deepEqual(report.bounced.red, { count: 1, of: 3, share: 1 / 3 });
  assert.deepEqual(report.bounced.reject, { count: 1, of: 3, share: 1 / 3 });
  assert.deepEqual(report.bounced.reopen, { count: 1, of: 2, share: 0.5 });
  assert.deepEqual(report.bounced.stale, { count: 1, of: 2, share: 0.5 });
  const lines = pipelinePerHourLines(report);
  assert.match(lines[0], /4 green submits · 2 items landed/u);
  assert.match(lines[1], /anthropic 2 accept \/ 2 reject; openai 2 accept \/ 0 reject/u);
  assert.match(lines[2], /red 33\.3% \(1 of 3\) · reject 33\.3% \(1 of 3\) · reopen 50\.0% \(1 of 2\) · stale 50\.0% \(1 of 2\)/u);
  const quiet = pipelinePerHour(history, { now: BASE + 86_400_000, windowMinutes: 60 });
  assert.equal(quiet.bounced.red.share, null, 'a stage nothing entered is unmeasured, never 0%');
  assert.match(pipelinePerHourLines(quiet)[2], /red unmeasured · reject unmeasured/u);
  assert.throws(() => pipelinePerHour(history, { windowMinutes: 0 }), { code: 'USAGE' });
});

test('clause 1: the real stats --window command prints the per-hour pipeline first and exposes it in JSON [C7]', async t => {
  const { root } = fixture(t, cycle(1));
  const text = await command(root, ['stats', '--window', '1h']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout.split('\n')[0], /^pipeline per hour \(window 60 min\): \d+ green submits · \d+ items landed$/u);
  assert.match(text.stdout, /\nbounced: red unmeasured/u);
  const json = JSON.parse((await command(root, ['stats', '--window', '1h', '--json'])).stdout);
  assert.equal(json.pipelineHour.windowMinutes, 60);
  assert.equal(json.pipelineHour.bounced.stale.share, null);
});
