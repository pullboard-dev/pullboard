/** The gate panel reads a gate job as live or stalled, the submit handoff is shadowed as a gate job, and gate spans are kept per day [C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { appendGateSpan } from '../../index.js';
import { createJob } from '../../index.js';
import { gatePanel } from '../../index.js';
import { gatePanelState } from '../../index.js';
import { gateSpanFolder } from '../../index.js';
import { jobView } from '../../index.js';
import { readGateSpans } from '../../index.js';
import { recordSubmitHandoff } from '../../index.js';
import { shadowSubmitHandoff } from '../../index.js';
import { stalledGates } from '../../index.js';
import { takeJob } from '../../index.js';
import { writeStep } from '../../index.js';

const MINUTE = 60_000;
const database = t => cellBoard(t, ':memory:').db;
const view = fields => ({ step: 'running', leaseOwner: 'w1', leaseUntil: 1000, updated: 500, ...fields });

test('jobs.panel.stalled-gate: a running or leased-queued gate whose lease lapsed reads stalled with its age in minutes, and a driven one does not [C7]', () => {
  const lapsed = gatePanelState(view({ leaseUntil: 10 * MINUTE }), 15 * MINUTE + 5);
  assert.deepEqual(lapsed, { state: 'stalled', stalled: true, ageMinutes: 5, text: 'stalled (reclaimable) 5m' });
  assert.equal(gatePanelState(view({ leaseUntil: 10 * MINUTE }), 10 * MINUTE).stalled, false, 'the lease ends now, not before');
  assert.deepEqual(gatePanelState(view({ step: 'queued', leaseOwner: null, leaseUntil: 0 }), 99 * MINUTE), { state: 'queued', stalled: false, ageMinutes: 0, text: 'queued' });
  assert.equal(gatePanelState(view({ step: 'queued', leaseUntil: 1 }), 5 * MINUTE).stalled, true, 'a queued job that took a lease is live');
  assert.equal(gatePanelState(view({ step: 'done' }), 99 * MINUTE).stalled, false);
  const free = view({ leaseOwner: null, leaseUntil: 0, updated: 2 * MINUTE });
  assert.equal(gatePanelState(free, 9 * MINUTE).ageMinutes, 7, 'an unleased running job ages from its last update');
  assert.equal(gatePanelState(free, 9 * MINUTE, { workerAlive: () => true }).stalled, false, 'a live worker drives an unleased job');
  assert.equal(gatePanelState(view({ leaseUntil: 1 }), 9 * MINUTE, { workerAlive: () => true }).stalled, true, 'a worker only vouches for an unleased job');
});

test('jobs.panel.reads-board: gatePanel and stalledGates read the board: unknown job and missing tables answer nothing, stalled gates are listed [C7]', t => {
  const db = database(t);
  assert.equal(gatePanel(db, 'gate:none'), null);
  createJob(db, { id: 'gate:1', kind: 'gate', item: 3, now: 0 });
  createJob(db, { id: 'gate:2', kind: 'gate', item: 4, now: 0 });
  createJob(db, { id: 'gate:3', kind: 'gate', item: 5, now: 0 });
  createJob(db, { id: 'land:1', kind: 'landing', item: 6, now: 0 });
  for (const id of ['gate:1', 'gate:2']) writeStep(db, id, 'running', {}, { now: 0 });
  takeJob(db, 'gate:1', 'w1', { now: 1, leaseMs: MINUTE - 1 });
  takeJob(db, 'gate:2', 'w2', { now: 1, leaseMs: 100 * MINUTE });
  assert.equal(gatePanel(db, 'gate:1', { now: 4 * MINUTE }).text, 'stalled (reclaimable) 3m');
  assert.equal(gatePanel(db, 'gate:2', { now: 4 * MINUTE }).stalled, false);
  assert.deepEqual(stalledGates(db, { now: 4 * MINUTE }), [{ id: 'gate:1', item: 3, text: 'stalled (reclaimable) 3m', ageMinutes: 3 }]);
  assert.deepEqual(stalledGates(db, { now: 4 * MINUTE, workerAlive: () => true }).map(row => row.id), ['gate:1']);
  const bare = new DatabaseSync(':memory:');
  assert.equal(gatePanel(bare, 'gate:1'), null);
  assert.deepEqual(stalledGates(bare), []);
});

test('jobs.panel.submit-shadow: a submit handoff is shadowed as a gate job whose steps repeat per state, and a board without job tables refuses [C7]', t => {
  const db = database(t);
  const handoff = { id: 'handoff:1', state: 'queued', commit: 'a'.repeat(40), main: 'b'.repeat(40), tree: 't', digest: 'd', agentId: 'core-1' };
  assert.deepEqual(shadowSubmitHandoff(db, 7, handoff, { now: 10 }), { job: 'handoff:1', step: 'queued', seq: 0 });
  assert.deepEqual(recordSubmitHandoff(db, 7, { ...handoff, error: { code: 'GATE_RED' }, retryOf: 'handoff:0' }, { now: 20 }), { job: 'handoff:1', step: 'queued', seq: 1 });
  const job = jobView(db, 'handoff:1');
  assert.deepEqual([job.kind, job.item, job.candidate, job.base], ['gate', 7, handoff.commit, handoff.main]);
  assert.deepEqual(job.steps.map(step => step.seq), [0, 1]);
  assert.deepEqual(job.steps[0].payload, { agent: 'core-1', commit: handoff.commit, tree: 't', digest: 'd', record: handoff });
  assert.equal(job.steps[1].payload.error, 'GATE_RED');
  assert.equal(job.steps[1].payload.retryOf, 'handoff:0');
  assert.throws(() => shadowSubmitHandoff(new DatabaseSync(':memory:'), 7, handoff), error => error.code === 'JOB_TABLES_MISSING');
});

/** A scratch folder for span files, removed after the test. */
function spanFolder(t) {
  const { root } = privateFixtureFiles('pullboard-spans-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return gateSpanFolder(root);
}
const span = (end, fields = {}) => ({ v: 1, job: 'gate:1', phase: 'run', start: end, end, ...fields });
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-09T12:00:00.000Z');

test('jobs.panel.spans-per-day: gate spans append to a file per day under the common dir, and reading returns those in range, skipping torn and foreign lines [C7]', t => {
  const folder = spanFolder(t);
  assert.match(folder, /pullboard\/gate-spans$/u);
  assert.deepEqual(readGateSpans(folder, { since: T0 - DAY, now: T0 }), [], 'no folder, no spans');
  appendGateSpan(folder, span(new Date(T0 - DAY).toISOString(), { phase: 'yesterday' }));
  appendGateSpan(folder, span(new Date(T0 - 60_000).toISOString(), { phase: 'today' }));
  appendFileSync(join(folder, '2026-11-09.jsonl'), '{"torn\n');
  appendFileSync(join(folder, '2026-11-09.jsonl'), JSON.stringify({ v: 2, job: 'x', phase: 'future', end: new Date(T0).toISOString() }) + '\n');
  writeFileSync(join(folder, 'notes.txt'), 'ignored');
  assert.deepEqual(readdirSync(folder).filter(name => name.endsWith('.jsonl')).sort(), ['2026-11-08.jsonl', '2026-11-09.jsonl']);
  assert.deepEqual(readGateSpans(folder, { since: T0 - 2 * DAY, now: T0 }).map(row => row.phase), ['yesterday', 'today']);
  assert.deepEqual(readGateSpans(folder, { since: T0 - 3 * 60_000, now: T0 }).map(row => row.phase), ['today'], 'an earlier day file is not read');
});

test('jobs.panel.span-retention: a new day\'s first span removes day files older than the 14-day window [C7]', t => {
  const folder = spanFolder(t);
  appendGateSpan(folder, span(new Date(T0 - 20 * DAY).toISOString()));
  appendGateSpan(folder, span(new Date(T0 - 14 * DAY).toISOString()));
  appendGateSpan(folder, span(new Date(T0).toISOString()));
  assert.deepEqual(readdirSync(folder).sort(), ['2026-10-26.jsonl', '2026-11-09.jsonl'], 'only the file older than the window went');
});
