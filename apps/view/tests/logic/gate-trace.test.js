/** The gate trace projection orders a job view's steps into phases with start, end, duration and gap rows in ms [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateTrace } from '../../src/logic/gate-trace.js';
import { phaseKind } from '../../src/logic/gate-trace.js';

const T0 = 1_700_000_000_000;
const step = (name, seq, at, payload = {}) => ({ name, seq, payload, at: T0 + at });
/** A gate job: two sections, a runner dispatch, READY, two test shards (written out of order), a requeue and a last section. */
const job = (values = {}) => ({ id: 'gate-job-1', kind: 'gate', item: 10314, step: 'done', created: T0, updated: T0 + 100_000, steps: [
  step('shard:b', 6, 45_000, { shard: 'b', endedAt: T0 + 70_000 }),
  step('section:static', 1, 0),
  step('section:cells', 2, 5_000, { endedAt: T0 + 12_000 }),
  step('artifact:log', 3, 13_000),
  step('dispatch', 4, 14_000),
  step('READY', 5, 20_000),
  step('shard:a', 7, 21_000, { shard: 'a', endedAt: T0 + 40_000 }),
  step('requeue', 8, 70_000),
  step('section:landing', 9, 80_000),
], ...values });

test('view.x-gate-trace.clause-1-every-phase-comes-back-in: clause 1: every phase comes back in start order with start, end and duration in ms [C7]', () => {
  const trace = gateTrace(job());
  const phases = trace.phases.filter((row) => row.type === 'phase');
  assert.deepEqual(phases.map((row) => row.name), ['section:static', 'section:cells', 'dispatch', 'READY', 'shard:a', 'shard:b', 'requeue', 'section:landing'],
    'sections, dispatch, READY, both shards and the requeue, in order; the posted artifact is not a phase');
  assert.deepEqual(phases.map((row) => row.kind), ['section', 'section', 'dispatch', 'ready', 'shard', 'shard', 'requeue', 'section']);
  for (const row of phases) assert.equal(row.ms, row.end - row.start, row.name + ' duration is end minus start');
  assert.deepEqual([phases[0].start, phases[0].end, phases[0].ms], [T0, T0 + 5_000, 5_000]);
  assert.deepEqual(phases.filter((row) => row.kind === 'shard').map((row) => row.shard), ['a', 'b']);
  assert.deepEqual([trace.start, trace.end, trace.totalMs, trace.item, trace.job, trace.running], [T0, T0 + 100_000, 100_000, 10_314, 'gate-job-1', false]);
  assert.equal(phases.at(-1).end, T0 + 100_000, 'the last phase of a finished job ends at its update time');
});

test('view.x-gate-trace.clause-1-gap-rows-hold-the-silence: clause 1: gap rows hold the silence between consecutive phases and add up with the phases to the whole [C7]', () => {
  const trace = gateTrace(job());
  const gaps = trace.phases.filter((row) => row.type === 'gap');
  assert.deepEqual(gaps.map((row) => [row.start - T0, row.end - T0, row.ms]), [[12_000, 14_000, 2_000], [40_000, 45_000, 5_000]], 'a gap sits only where a phase ended before the next began');
  assert.equal(trace.gapMs, 7_000);
  assert.equal(trace.busyMs + trace.gapMs, trace.totalMs);
  for (let at = 1; at < trace.phases.length; at += 1) assert.equal(trace.phases[at].start, trace.phases[at - 1].end, 'rows follow each other with no overlap');
});

test('view.x-gate-trace.clause-2-a-running-gate-returns-the: clause 2: a running gate returns the phase it is in now with its elapsed ms against the given now [C7]', () => {
  const running = job({ step: 'shard:b', updated: T0 + 60_000, steps: job().steps.filter((row) => row.at <= T0 + 45_000) });
  const trace = gateTrace(running, { now: T0 + 52_500 });
  assert.equal(trace.running, true);
  assert.deepEqual([trace.current.name, trace.current.kind, trace.current.open, trace.current.start - T0, trace.current.ms], ['shard:b', 'shard', true, 45_000, 7_500]);
  assert.equal(trace.end, T0 + 52_500, 'the trace runs to now');
  assert.equal(trace.phases.filter((row) => row.open).length, 1, 'only the last phase is open');
  assert.equal(gateTrace(running, { now: T0 + 60_000 }).current.ms, 15_000, 'a later now grows the elapsed time');
  assert.equal(gateTrace(job()).current, null, 'a finished gate has no current phase');
});

test('view.x-gate-trace.clause-1-an-empty-job-has-no: clause 1: an empty job has no rows and an unknown step name is a plain step [C7]', () => {
  assert.deepEqual(gateTrace({ created: T0, steps: [] }).phases, []);
  assert.equal(phaseKind('mystery'), 'step');
});
