/** pullboard stats runners --utilization reads the board's job history and gives exact busy-over-total slot figures [C7,#6032]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runnerUtilization } from '../../../../../packages/stats/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { withFixtureBoard } from '../../../tests/fixtures/testkit.js';

const HOUR = 3_600_000, MIN = 60_000;

/** A real project whose board holds seeded job history in whole past hours; its setup events are cleared so only seeded seats count. */
function fixture(t) {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const h = Math.floor(Date.now() / HOUR) * HOUR;
  withFixtureBoard(box.boardFile, board => {
    board.db.exec('DELETE FROM event');
    seed(board.db, h);
  });
  return { box, h };
}

/** Insert the seeded job history. */
function seed(db, h) {
  const job = (id, runner, jobs, start, minutes) => {
    db.prepare("INSERT INTO job (job_id, job_kind, job_step, job_created, job_updated) VALUES (?, 'test-run', 'done', ?, ?)").run(id, start - 1000, start + minutes * MIN);
    const step = (name, payload, at) => db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, ?, ?, ?)').run(id, name, JSON.stringify(payload), at);
    step('claimed', { runner, ...(jobs ? { jobs } : {}) }, start);
    step('result', {}, start + minutes * MIN);
  };
  const add = job;
  add('a1', 'runner-a', 2, h - 2 * HOUR, 30);
  add('b1', 'runner-b', 4, h - 2 * HOUR, 60);
  add('b2', 'runner-b', 4, h - 2 * HOUR, 60);
  add('a2', 'runner-a', 2, h - HOUR, 60);
  add('a3', 'runner-a', 2, h - HOUR, 60);
}

test('utilization two seeded runners give exact busy over total slots per hour, runner and overall [C7,#6032]', async t => {
  const { box, h } = fixture(t);
  const result = await box.runLocal(box.web, 'stats', 'runners', '--utilization', '--window', '3h', '--json');
  assert.equal(result.code, 0, result.err);
  const report = JSON.parse(result.out).runnersUtilization;
  assert.deepEqual(report.runners.map(row => [row.runner, row.slots, row.source, row.busyMinutes]), [['runner-a', 2, 'declared', 150], ['runner-b', 4, 'declared', 120]]);
  const hour = at => report.hours.find(row => row.hour === new Date(at).toISOString());
  assert.equal(hour(h - 2 * HOUR).busySlotMinutes, 150); assert.equal(hour(h - 2 * HOUR).totalSlots, 6);
  assert.equal(hour(h - 2 * HOUR).utilization, 150 / 360);
  assert.equal(hour(h - HOUR).utilization, 120 / 360);
  assert.equal(report.hours.length, 4);
  assert.deepEqual(report.runners.map(row => row.utilization), [150 / 480, 120 / 960]);
  assert.deepEqual(report.overall, { slots: 6, busyMinutes: 270, utilization: 270 / 1440 });
  assert.deepEqual(report.peak, { hour: new Date(h - 2 * HOUR).toISOString(), utilization: 150 / 360 });
  assert.deepEqual(report.idleHours, [new Date(h - 3 * HOUR).toISOString(), new Date(h).toISOString()]);
  const text = await box.runLocal(box.web, 'stats', 'runners', '--utilization', '--window', '3h');
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /runner-a: 31\.3% of 2 slots \(declared\)/u);
});

test('utilization sizes a runner that declared no jobs setting by its peak concurrency and says so [C7,#6032]', () => {
  const now = Date.UTC(2026, 10, 12, 10, 30);
  const start = Date.UTC(2026, 10, 12, 9, 0);
  const spans = [{ runner: 'old', start, end: start + 30 * MIN, declared: null }, { runner: 'old', start: start + 10 * MIN, end: start + 40 * MIN, declared: null }];
  const report = runnerUtilization(spans, { now, windowMinutes: 120 });
  assert.deepEqual(report.runners, [{ runner: 'old', slots: 2, source: 'observed peak', busyMinutes: 60, utilization: 60 / (2 * 3 * 60) }]);
});
