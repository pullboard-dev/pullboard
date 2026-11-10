/** Gate phase spans and the gate-health report, against a real Git repo and SQLite board [C7]. */
// @pullboard-reads packages/resources/src/io/spans/gate.js packages/gate/src/logic/health.js packages/gate/src/io/health.js apps/cli/src/io/commands/gate-health.js
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { events } from '../../../../packages/store/index.js';
import {
  gateSpanFolder,
  readGateSpans,
  recordSubmitHandoff,
} from '../../../../packages/jobs/index.js';
import {
  closeGateSpans,
  gateSpanCause,
  openGateSpans,
  recordGateSpan,
  recordRunnerDispatch,
} from '../../../../packages/resources/index.js';
import {
  closeLandingSpans,
  openLandingSpans,
  readLandingSpans,
} from '../../../../packages/resources/index.js';
import { RunnerDropped } from '../../../../packages/gate/index.js';
import { gateHealthReport } from '../../../../packages/gate/index.js';
import { gateHealthWindowMs } from '../../src/io/commands/gate-health.js';
import { main } from '../../tests/fixtures/native.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { withFixtureBoard } from '../../tests/fixtures/testkit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const helpers = createE2eHelpers();

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const MIN = 60_000;

/** A private folder standing in for a common Git directory, for span files alone. */
function spanRoot(t) {
  const { root } = privateFixtureFiles('pullboard-gate-spans-');
  t.after(() => { closeGateSpans(); rmSync(root, { recursive: true, force: true }); });
  return root;
}

/** A real Git repository set up with pullboard, its real SQLite board, and a fixed clock. */
function fixture(t) {
  t.after(() => { closeGateSpans(); helpers.cleanup(); });
  const root = helpers.project('true', helpers.sandbox(), { withWorktree: false }).repo;
  const commonDir = join(root, '.git');
  const clock = { now: () => new Date(NOW) };
  // @pullboard-board-file journey: the public gate-health command reads this fixture's hand-off records.
  const file = join(commonDir, 'pullboard', 'board.sqlite');
  /** Run a body on the fixture board through the kit seam. */
  const withBoard = body => withFixtureBoard(file, body);
  /** Save one hand-off record through the job cell's writer, as the hand-off moves do. */
  const handoff = (item, record) => withBoard(board => recordSubmitHandoff(board.db, item, { version: 1, agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40),
    main: 'c'.repeat(40), digest: 'd'.repeat(64), ...record }, { now: Date.parse(record.completedAt ?? record.startedAt ?? record.at) }));
  /** Run the real public command in-process. */
  async function cli(...args) {
    let stdout = '', stderr = '';
    const code = await main(args, { cwd: root, clock, stdout: { isTTY: false, write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
    return { code, stdout, stderr, data: args.includes('--json') ? JSON.parse(stdout) : null };
  }
  return { root, commonDir, withBoard, handoff, cli };
}

const iso = ms => new Date(ms).toISOString();

test('[C7] a gate worker records one typed span per phase in the daily span file, and nothing without an open sink', t => {
  const folder = gateSpanFolder(spanRoot(t));
  assert.equal(recordGateSpan({ phase: 'queued', start: NOW - MIN, end: NOW }), null, 'no open sink records nothing');
  openGateSpans({ folder, job: 'job-1', item: 7 });
  const queued = recordGateSpan({ phase: 'queued', start: NOW - 2 * MIN, end: NOW - MIN });
  assert.deepEqual(queued, { v: 1, job: 'job-1', item: 7, phase: 'queued', start: iso(NOW - 2 * MIN), end: iso(NOW - MIN), ms: MIN, host: 'local', outcome: 'ok' });
  recordRunnerDispatch({ startedAt: NOW - 50_000, endedAt: NOW - 10_000, host: 'runner-a', kind: 'submit',
    phases: { start: NOW - 50_000, connect: NOW - 50_000, inventory: NOW - 48_000, pack: NOW - 47_000, 'source-sent': NOW - 45_000, ready: NOW - 40_000 } });
  const dropped = new RunnerDropped('runner-b', { reason: 'admission-deadline', phase: 'source-sent' });
  recordRunnerDispatch({ startedAt: NOW - 30_000, endedAt: NOW - 20_000, host: 'runner-b', kind: 'submit', error: dropped });
  closeGateSpans();
  assert.equal(recordGateSpan({ phase: 'result', start: NOW, end: NOW }), null, 'a closed sink records nothing');
  assert.deepEqual(readdirSync(folder), ['2026-11-08.jsonl'], 'spans land in the UTC day file of their end');
  const spans = readGateSpans(folder, { since: NOW - 3_600_000, now: NOW });
  assert.deepEqual(spans.map(span => [span.phase, span.ms, span.host, span.outcome, span.cause ?? null]), [
    ['queued', MIN, 'local', 'ok', null],
    ['transfer', 5_000, 'runner-a', 'ok', null],
    ['ready', 5_000, 'runner-a', 'ok', null],
    ['tests', 30_000, 'runner-a', 'ok', null],
    ['ready', 10_000, 'runner-b', 'failed', 'readiness-miss'],
  ]);
  writeFileSync(join(folder, '2026-11-08.jsonl'), readFileSync(join(folder, '2026-11-08.jsonl'), 'utf8') + '{"torn":\n');
  assert.equal(readGateSpans(folder, { since: NOW - 3_600_000, now: NOW }).length, 5, 'a torn line is skipped');
});

test('[C7] a dispatch records its tooling export, controller start and source preparation before transfer, so no time from its start to its connect goes unattributed', t => {
  const folder = gateSpanFolder(spanRoot(t));
  openGateSpans({ folder, job: 'job-2', item: 8 });
  recordRunnerDispatch({ startedAt: NOW - 60_000, endedAt: NOW, host: 'runner-a', kind: 'submit',
    phases: { spawn: NOW - 58_000, prepare: NOW - 55_000, prepared: NOW - 45_000, start: NOW - 44_000, connect: NOW - 44_000, 'source-sent': NOW - 40_000, ready: NOW - 30_000 } });
  closeGateSpans();
  const spans = readGateSpans(folder, { since: NOW - 3_600_000, now: NOW });
  assert.deepEqual(spans.map(span => [span.phase, span.ms]), [
    ['dispatch-tooling', 2_000], ['dispatch-controller', 3_000], ['dispatch-prepare', 10_000], ['dispatch-connect', 1_000],
    ['transfer', 4_000], ['ready', 10_000], ['tests', 30_000],
  ]);
  const covered = spans.reduce((sum, span) => sum + span.ms, 0);
  assert.equal(covered, 60_000, 'the spans cover the dispatch from its start to its end with no gap');
});

test('[C7] a landing runner run with no gate open records its dispatch steps, transfer, READY and tests into its landing run', t => {
  const commonDir = spanRoot(t);
  t.after(closeLandingSpans);
  const run = openLandingSpans({ commonDir });
  recordRunnerDispatch({ startedAt: NOW - 60_000, endedAt: NOW, host: 'runner-a', kind: 'land',
    phases: { spawn: NOW - 58_000, prepare: NOW - 55_000, prepared: NOW - 45_000, start: NOW - 44_000, connect: NOW - 44_000, 'source-sent': NOW - 40_000, ready: NOW - 30_000 } });
  closeLandingSpans();
  const spans = readLandingSpans(commonDir, { since: NOW - 3_600_000, now: NOW });
  assert.deepEqual(spans.map(span => [span.job, span.phase, span.ms, span.host, span.runKind]), [
    [run, 'dispatch-tooling', 2_000, 'runner-a', 'land'], [run, 'dispatch-controller', 3_000, 'runner-a', 'land'],
    [run, 'dispatch-prepare', 10_000, 'runner-a', 'land'], [run, 'dispatch-connect', 1_000, 'runner-a', 'land'],
    [run, 'transfer', 4_000, 'runner-a', 'land'], [run, 'ready', 10_000, 'runner-a', 'land'], [run, 'tests', 30_000, 'runner-a', 'land'],
  ]);
  assert.deepEqual(readGateSpans(gateSpanFolder(commonDir), { since: NOW - 3_600_000, now: NOW }), [], 'no gate span is written for a landing run');
});

test('[C7] infrastructure failures map to the typed causes', () => {
  assert.equal(gateSpanCause(new RunnerDropped('h', { reason: 'admission-deadline' })), 'readiness-miss');
  assert.equal(gateSpanCause(new RunnerDropped('h', { reason: 'bridge-exit' })), 'transport-lost');
  assert.equal(gateSpanCause({ code: 'RUNNER_UNAVAILABLE' }), 'runner-dropped');
  assert.equal(gateSpanCause({ code: 'RUNNER_JOB_LOST' }), 'runner-dropped');
  assert.equal(gateSpanCause({ code: 'RUNNER_WAIT_DEADLINE' }), 'deadline');
  assert.equal(gateSpanCause({ code: 'RUNNER_INFRA_RETRY_EXHAUSTED' }), 'infra-retry');
  assert.equal(gateSpanCause({ code: 'GATE_RED' }), null, 'a red gate is no infrastructure cause');
});

test('[C7] gate-health reports count, total p50/p90, time per phase, causes with hosts and the slowest gates with their dominant phase', async t => {
  const f = fixture(t);
  // Gate #1: its first job died on infrastructure, its retry went green with spans.
  f.handoff(1, { id: 'g1a', state: 'infrastructure', at: iso(NOW - 60 * MIN), startedAt: iso(NOW - 58 * MIN), completedAt: iso(NOW - 50 * MIN),
    error: { code: 'SUBMIT_HANDOFF_DEAD', message: 'dead' } });
  f.handoff(1, { id: 'g1b', state: 'green', retryOf: 'g1a', at: iso(NOW - 48 * MIN), startedAt: iso(NOW - 45 * MIN), completedAt: iso(NOW - 10 * MIN) });
  // Gate #2: red, recorded before spans existed.
  f.handoff(2, { id: 'g2', state: 'red', at: iso(NOW - 30 * MIN), startedAt: iso(NOW - 29 * MIN), completedAt: iso(NOW - 20 * MIN), error: { code: 'GATE_RED', message: 'red' } });
  // Gate #3 is still running; gate #4 ended before the window.
  f.handoff(3, { id: 'g3', state: 'running', at: iso(NOW - 5 * MIN), startedAt: iso(NOW - 4 * MIN) });
  f.handoff(4, { id: 'g4', state: 'green', at: iso(NOW - 200 * MIN), startedAt: iso(NOW - 199 * MIN), completedAt: iso(NOW - 190 * MIN) });
  openGateSpans({ folder: gateSpanFolder(f.commonDir), job: 'g1b', item: 1 });
  recordGateSpan({ phase: 'queued', start: NOW - 48 * MIN, end: NOW - 45 * MIN });
  recordGateSpan({ phase: 'doctrine', start: NOW - 44 * MIN, end: NOW - 40 * MIN, outcome: 'done' });
  recordGateSpan({ phase: 'admission', start: NOW - 40 * MIN, end: NOW - 39 * MIN, host: 'runner-a' });
  recordRunnerDispatch({ startedAt: NOW - 39 * MIN, endedAt: NOW - 38 * MIN, host: 'runner-a', kind: 'submit', error: { code: 'RUNNER_UNAVAILABLE', diagnostic: { phase: 'connect' } } });
  recordGateSpan({ phase: 'retry', start: NOW - 38 * MIN, end: NOW - 36 * MIN, host: 'runner-a', outcome: 'retry', cause: 'infra-retry', code: 'RUNNER_UNAVAILABLE' });
  recordRunnerDispatch({ startedAt: NOW - 36 * MIN, endedAt: NOW - 12 * MIN, host: 'runner-b', kind: 'submit',
    phases: { connect: NOW - 36 * MIN, 'source-sent': NOW - 35 * MIN, ready: NOW - 34 * MIN } });
  recordGateSpan({ phase: 'result', start: NOW - 11 * MIN, end: NOW - 10 * MIN });
  recordGateSpan({ phase: 'gate', start: NOW - 60 * MIN, end: NOW - 10 * MIN, outcome: 'green' });
  closeGateSpans();
  const before = f.withBoard(board => events(board).length);
  const result = await f.cli('gate-health', '--since', '2h', '--json');
  assert.equal(result.code, 0, result.stderr);
  const report = result.data.report;
  assert.equal(report.gates, 2, 'two gates ended in the window; a live gate and an older one are not counted');
  assert.equal(report.live, 1);
  assert.equal(report.spanned, 1);
  assert.deepEqual(report.total, { p50: 10 * MIN, p90: 50 * MIN }, 'a retried gate runs from its first queue time to its last end');
  const phase = Object.fromEntries(report.phases.map(row => [row.phase, row]));
  assert.deepEqual(Object.keys(phase), ['queued', 'doctrine', 'admission', 'transfer', 'ready', 'tests', 'retry', 'result', 'worker', 'requeue']);
  assert.deepEqual([phase.queued.gates, phase.queued.sumMs], [2, (2 + 3 + 1) * MIN], 'board queue time fills a job with no queued span');
  assert.deepEqual([phase.tests.sumMs, phase.worker.sumMs, phase.requeue.sumMs], [22 * MIN, (8 + 9) * MIN, 2 * MIN]);
  assert.deepEqual([phase.transfer.sumMs, phase.transfer.p50Ms], [2 * MIN, 2 * MIN], 'the failed connect and the sent source are both transfer time');
  assert.deepEqual(report.causes.map(row => [row.cause, row.code, row.count, row.hosts]), [
    ['infra-retry', 'RUNNER_UNAVAILABLE', 1, { 'runner-a': 1 }],
    ['infra-retry', 'SUBMIT_HANDOFF_DEAD', 1, {}],
    ['runner-dropped', 'RUNNER_UNAVAILABLE', 1, { 'runner-a': 1 }],
  ]);
  assert.deepEqual(report.slowest.map(gate => [gate.item, gate.totalMs, gate.attempts, gate.dominant.phase, gate.dominant.ms]),
    [[1, 50 * MIN, 2, 'tests', 22 * MIN], [2, 10 * MIN, 1, 'worker', 9 * MIN]]);
  assert.equal(f.withBoard(board => events(board).length), before, 'the report records no move');
  const text = await f.cli('gate-health', '--since', '2h');
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^gate health, last 2h /mu);
  assert.match(text.stdout, /2 gates ended \(1 with phase spans\), 1 still queued or running; total p50 10m00s, p90 50m00s/u);
  assert.match(text.stdout, /runner-dropped RUNNER_UNAVAILABLE: 1 \(runner-a 1\)/u);
  assert.match(text.stdout, /#1 +50m00s green, 2 attempts; most time in tests 22m00s/u);
  assert.match(text.stdout, /#2 +10m00s red GATE_RED; most time in worker 9m00s \(board times only\)/u);
});

test('[C7] gate-health reads only the window: older and live gates stay out, and a read writes nothing', t => {
  const f = fixture(t);
  f.withBoard(board => {
    for (let index = 0; index < 400; index += 1) {
      recordSubmitHandoff(board.db, index + 1, { version: 1, id: `bulk-${index}`, agentId: 'core-1', state: 'green', at: iso(NOW - 100 * MIN), startedAt: iso(NOW - 99 * MIN),
        completedAt: iso(NOW - (index < 300 ? 90 - index % 60 : 300) * MIN) }, { now: NOW - 30 * MIN });
    }
  });
  const report = f.withBoard(board => gateHealthReport(board.db, { commonDir: f.commonDir, since: NOW - 2 * 3_600_000, now: NOW }));
  assert.equal(report.gates, 300, 'the 100 gates that ended five hours ago are outside a two-hour window');
  assert.equal(report.slowest.length, 10);
  assert.equal(existsSync(gateSpanFolder(f.commonDir)), false, 'a read creates no span folder');
});

test('[C7] gate-health refuses a window it cannot read', () => {
  assert.equal(gateHealthWindowMs('90m'), 90 * MIN);
  assert.equal(gateHealthWindowMs('1d'), 86_400_000);
  for (const bad of ['0h', '2', 'h', '-1h']) assert.throws(() => gateHealthWindowMs(bad), { code: 'USAGE' });
});
