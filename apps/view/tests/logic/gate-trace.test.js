/** The gate trace projection orders a job view's steps into phases with start, end, duration and gap rows in ms [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateTrace } from '../../src/logic/gate-trace.js';
import { phaseKind } from '../../src/logic/gate-trace.js';

const T0 = 1_700_000_000_000;
const step = (name, seq, at, payload = {}) => ({ name, seq, payload, at: T0 + at });
/** A gate job that ran two sections, dispatched to a runner, waited for READY, ran two test shards, was requeued and ran again. */
const job = () => ({ id: 'gate-job-1', kind: 'gate', item: 10314, created: T0, updated: T0 + 100_000, steps: [
  step('shard:b', 6, 70_000, { startedAt: T0 + 45_000, shard: 'b' }),
  step('section:static', 1, 5_000, { startedAt: T0 }),
  step('section:cells', 2, 12_000, { startedAt: T0 + 5_000 }),
  step('artifact:log', 3, 13_000),
  step('dispatch', 4, 20_000, { startedAt: T0 + 14_000 }),
  step('READY', 5, 21_000, { startedAt: T0 + 20_000 }),
  step('shard:a', 7, 40_000, { startedAt: T0 + 21_000, shard: 'a' }),
  step('requeue', 8, 80_000, { startedAt: T0 + 70_000 }),
  step('section:landing', 9, 100_000, { startedAt: T0 + 80_000 }),
] });

test('clause 1: every phase comes back in start order with start, end and duration in ms [C7]', () => {
  const trace = gateTrace(job());
  const phases = trace.phases.filter((row) => row.type === 'phase');
  assert.deepEqual(phases.map((row) => row.name), ['section:static', 'section:cells', 'dispatch', 'READY', 'shard:a', 'shard:b', 'requeue', 'section:landing'],
    'sections, dispatch, READY, both shards and the requeue, in order; the posted artifact is not a phase');
  assert.deepEqual(phases.map((row) => row.kind), ['section', 'section', 'dispatch', 'ready', 'shard', 'shard', 'requeue', 'section']);
  for (const row of phases) assert.equal(row.ms, row.end - row.start, row.name + ' duration is end minus start');
  assert.deepEqual([phases[0].start, phases[0].end, phases[0].ms], [T0, T0 + 5_000, 5_000]);
  assert.deepEqual(phases.filter((row) => row.kind === 'shard').map((row) => row.shard), ['a', 'b']);
  assert.deepEqual([trace.start, trace.end, trace.totalMs, trace.item, trace.job], [T0, T0 + 100_000, 100_000, 10_314, 'gate-job-1']);
});

test('clause 1: gap rows hold the silence between consecutive phases and add up with the phases to the whole [C7]', () => {
  const trace = gateTrace(job());
  const gaps = trace.phases.filter((row) => row.type === 'gap');
  assert.deepEqual(gaps.map((row) => [row.start - T0, row.end - T0, row.ms]), [[12_000, 14_000, 2_000], [40_000, 45_000, 5_000]], 'a gap sits only where a phase starts after the previous ended');
  assert.equal(trace.gapMs, 7_000);
  assert.equal(trace.busyMs + trace.gapMs, trace.totalMs);
  for (let at = 1; at < trace.phases.length; at += 1) assert.ok(trace.phases[at].start >= trace.phases[at - 1].start, 'rows never go back in time');
});

test('clause 1: a step with no declared start begins where the one before it ended, and an empty job has no rows [C7]', () => {
  const plain = gateTrace({ id: 'j', item: 1, created: T0, updated: T0 + 30, steps: [step('queued', 1, 10), step('started', 2, 30)] });
  assert.deepEqual(plain.phases.map((row) => [row.type, row.start - T0, row.end - T0, row.ms]), [['phase', 0, 10, 10], ['phase', 10, 30, 20]]);
  assert.equal(plain.gapMs, 0);
  assert.deepEqual(gateTrace({ created: T0, steps: [] }).phases, []);
  assert.equal(phaseKind('mystery'), 'step');
});
