/** A replay over a recorded job log (the offered, claimed, released, progress and receipt steps a board wrote) agrees with the job table on every recorded move [C7,#8239]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobEngine } from '../../../index.js';
import { replayTable } from '../../../index.js';

const LEASE_MS = 120_000;
const { rules, table } = jobEngine({ leaseMs: LEASE_MS, maxAttempts: 12 });
const T0 = Date.parse('2026-11-15T12:00:00.000Z');
const CUT = '2026-11-10T00:00:00.000Z';
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

/** What the jobs store wrote for one job, in event order: the step, the second it was written, its attempt, the runner and token that moved it, and the lease the row held before it. */
const LOG = [
  { id: 1, at: 0, move: { name: 'offer', kind: 'land' }, before: null, step: { kind: 'job.step', step: 'offered' } },
  { id: 2, at: 5, move: { name: 'claim', runner: 'a', token: 'ta' }, before: { kind: 'land', step: 'offered', attempt: 0, owner: null, leaseUntil: 0, claim: null }, step: { kind: 'job.step', step: 'claimed', attempt: 1, runner: 'a' } },
  { id: 3, at: 10, move: { name: 'claim', runner: 'b', token: 'tb' }, before: { kind: 'land', step: 'claimed', attempt: 1, owner: 'a', leaseUntil: T0 + 5_000 + LEASE_MS, claim: { runner: 'a', token: 'ta' } }, refused: 'JOB_HELD' },
  { id: 4, at: 20, move: { name: 'progress', runner: 'a', token: 'ta' }, before: { kind: 'land', step: 'claimed', attempt: 1, owner: 'a', leaseUntil: T0 + 5_000 + LEASE_MS, claim: { runner: 'a', token: 'ta' } }, step: { kind: 'job.step', step: 'progress', attempt: 1 } },
  { id: 5, at: 30, move: { name: 'release', runner: 'a', token: 'ta' }, before: { kind: 'land', step: 'claimed', attempt: 1, owner: 'a', leaseUntil: T0 + 5_000 + LEASE_MS, claim: { runner: 'a', token: 'ta' } }, step: { kind: 'job.step', step: 'released', attempt: 1, runner: 'a' } },
  { id: 6, at: 40, move: { name: 'claim', runner: 'b', token: 'tb' }, before: { kind: 'land', step: 'claimed', attempt: 1, owner: null, leaseUntil: T0 + 60_000, claim: { runner: 'a', token: 'ta' } }, refused: 'JOB_HELD' },
  { id: 7, at: 100, move: { name: 'claim', runner: 'b', token: 'tb' }, before: { kind: 'land', step: 'claimed', attempt: 1, owner: null, leaseUntil: T0 + 60_000, claim: { runner: 'a', token: 'ta' } }, step: { kind: 'job.step', step: 'claimed', attempt: 2, runner: 'b' } },
  { id: 8, at: 110, move: { name: 'renew', runner: 'a', token: 'ta' }, before: { kind: 'land', step: 'claimed', attempt: 2, owner: 'b', leaseUntil: T0 + 100_000 + LEASE_MS, claim: { runner: 'b', token: 'tb' } }, refused: 'JOB_LEASE_MOVED' },
  { id: 9, at: 120, move: { name: 'shards', runner: 'b', token: 'tb' }, before: { kind: 'land', step: 'claimed', attempt: 2, owner: 'b', leaseUntil: T0 + 100_000 + LEASE_MS, claim: { runner: 'b', token: 'tb' } }, events: [] },
  { id: 10, at: 130, move: { name: 'receipt', runner: 'b', token: 'tb' }, before: { kind: 'land', step: 'claimed', attempt: 2, owner: 'b', leaseUntil: T0 + 100_000 + LEASE_MS, claim: { runner: 'b', token: 'tb' } }, step: { kind: 'job.step', step: 'receipt', attempt: 2, runner: 'b' } },
  { id: 11, at: 140, move: { name: 'progress', runner: 'b', token: 'tb' }, before: { kind: 'land', step: 'done', attempt: 2, owner: null, leaseUntil: 0, claim: { runner: 'b', token: 'tb' } }, refused: 'JOB_DONE' },
  { id: 12, at: 150, move: { name: 'receipt', runner: 'b', token: 'tb' }, before: { kind: 'land', step: 'done', attempt: 2, owner: null, leaseUntil: 0, claim: { runner: 'b', token: 'tb' } }, events: [] },
  { id: 13, at: 160, move: { name: 'renew', runner: 'zz', token: 'x' }, before: null, refused: 'JOB_MISSING' },
];

/** A log row as the replay reads it: the snapshot the row saw and the decision the board wrote. */
const records = (log) => log.map(row => ({ event: { id: row.id, at: at(row.at) }, snapshot: { job: row.before, now: T0 + row.at * 1000 }, move: row.move,
  recorded: row.refused ? { refused: row.refused } : { events: row.step ? [row.step] : (row.events ?? []) } }));

test('replaying a recorded job log agrees with the table on every move: offer, claim, held, progress, release, reclaim, fenced, receipt and done [C7,#8239]', () => {
  const report = replayTable(table, rules, records(LOG), { cut: CUT });
  assert.deepEqual(report.disagreements, []);
  assert.deepEqual([report.total, report.agreed, report.disagreed, report.notReplayable], [13, 13, 0, 0]);
});

test('a log that disagrees with the table is found by event id: a claim recorded over a live lease, and a receipt recorded for a stale token [C7,#8239]', () => {
  const bad = LOG.map(row => (row.id === 3 ? { ...row, refused: undefined, step: { kind: 'job.step', step: 'claimed', attempt: 2, runner: 'b' } }
    : row.id === 10 ? { ...row, move: { ...row.move, token: 'stale' } } : row));
  const report = replayTable(table, rules, records(bad), { cut: CUT });
  assert.deepEqual(report.disagreements.map(each => [each.event, each.differs]), [[3, 'decision'], [10, 'decision']]);
  assert.equal(report.agreed, 11);
});
