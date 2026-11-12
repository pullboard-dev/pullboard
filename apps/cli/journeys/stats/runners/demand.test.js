/** pullboard stats runners --demand gives exact proof jobs and slot-minutes per active seat [C7,#6034]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { runnerDemand } from '../../../../../packages/stats/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { withFixtureBoard } from '../../../tests/fixtures/testkit.js';

const HOUR = 3_600_000, MIN = 60_000;

/** A real project whose board holds seeded job history in whole past hours; its setup events are cleared so only seeded seats count. */
function fixture(t) {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const h = Math.floor(Date.now() / HOUR) * HOUR;
  withFixtureBoard(join(box.repo, '.git/pullboard/board.sqlite'), board => {
    board.db.exec('DELETE FROM event');
    seed(board.db, h);
  });
  return { box, h };
}

/** Insert the seeded job history. */
function seed(db, h) {
  const job = (id, start, minutes) => {
    db.prepare("INSERT INTO job (job_id, job_kind, job_step, job_created, job_updated) VALUES (?, 'test-run', 'done', ?, ?)").run(id, start, start + minutes * MIN);
    const step = (name, at) => db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, ?, ?, ?)').run(id, name, '{}', at);
    step('running', start); step('result', start + minutes * MIN);
  };
  const event = (seat, at) => db.prepare("INSERT INTO event (event_at, event_by, event_kind, event_detail) VALUES (?, ?, 'fact', '{}')").run(new Date(at).toISOString(), seat);
  job('j1', h - 2 * HOUR + 5 * MIN, 30); job('j2', h - 2 * HOUR + 5 * MIN, 45); job('j3', h - 2 * HOUR + 10 * MIN, 15);
  job('j4', h - HOUR, 60);
  event('core-1', h - 2 * HOUR + MIN); event('core-1', h - 2 * HOUR + 2 * MIN); event('core-2', h - 2 * HOUR + 3 * MIN);
  event('core-1', h - HOUR + MIN);
}

test('demand seeded seats and jobs give exact proof jobs, slot-minutes and slots per agent [C7,#6034]', async t => {
  const { box, h } = fixture(t);
  const result = await box.runLocal(box.repo, 'stats', 'runners', '--demand', '--window', '3h', '--json');
  assert.equal(result.code, 0, result.err);
  const report = JSON.parse(result.out).runnersDemand;
  const hour = at => report.hours.find(row => row.hour === new Date(at).toISOString());
  assert.deepEqual(hour(h - 2 * HOUR), { hour: new Date(h - 2 * HOUR).toISOString(), activeSeats: 2, proofJobs: 3, slotMinutes: 90, jobsPerSeat: 1.5, slotMinutesPerSeat: 45, slotsPerAgent: 90 / 60 / 2 });
  assert.deepEqual(hour(h - HOUR), { hour: new Date(h - HOUR).toISOString(), activeSeats: 1, proofJobs: 1, slotMinutes: 60, jobsPerSeat: 1, slotMinutesPerSeat: 60, slotsPerAgent: 1 });
  assert.equal(hour(h - 3 * HOUR).slotsPerAgent, null);
  assert.deepEqual(report.overall, { proofJobs: 4, slotMinutes: 150, seatHours: 3, jobsPerSeatHour: 4 / 3, slotMinutesPerSeatHour: 50, slotsPerAgent: 150 / 60 / 3 });
  const text = await box.runLocal(box.repo, 'stats', 'runners', '--demand', '--window', '3h');
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /0\.83 slots per agent/u);
});

test('demand an hour with no active seat reports no per-seat figures [C7,#6034]', () => {
  const now = Date.UTC(2026, 10, 12, 10, 30), start = Date.UTC(2026, 10, 12, 9, 0);
  const report = runnerDemand([{ start, end: start + 30 * MIN }], [start], [], { now, windowMinutes: 60 });
  assert.equal(report.overall.slotsPerAgent, null);
  assert.deepEqual(report.hours.map(row => [row.activeSeats, row.proofJobs, row.slotMinutes, row.slotsPerAgent]), [[0, 1, 30, null], [0, 0, 0, null]]);
});
