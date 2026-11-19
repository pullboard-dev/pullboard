/** An unanswered seat shout to the coordinator past health.stuck is one Stuck finding in the health report [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { healthReport } from '../../../index.js';
import { healthLines } from '../../../index.js';

const HOUR = 3_600_000;

/** A board with the shouts given as [from, to, text, hoursAgo, answers, item], and the health report read at the board's clock. */
function report(t, shouts) {
  const board = fixtureBoard(t);
  const now = board.clock.now();
  const insert = board.db.prepare('INSERT INTO shout (shout_from, shout_to, shout_text, shout_at, shout_answers, shout_evidence_item) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [from, to, text, hours, answers = null, item = null] of shouts) insert.run(from, to, text, new Date(now.getTime() - hours * HOUR).toISOString(), answers, item);
  return healthReport({ db: board.db, root: process.cwd(), config: {}, now, dispatchHealth: () => ({ findings: [] }) });
}

test('health.io-main-shouts.unanswered-stuck: clause 1: one SHOUT_UNANSWERED finding names the shout id, the sender, the item and the age [C7]', t => {
  const { stuck } = report(t, [['core-1', 'coordinator', 'blocked on the schema', 3, null, 77]]);
  const found = stuck.filter(row => row.cause === 'SHOUT_UNANSWERED');
  assert.equal(found.length, 1);
  assert.equal(found[0].detail.shout, 1);
  assert.equal(found[0].detail.from, 'core-1');
  assert.equal(found[0].detail.item, 77);
  assert.equal(found[0].ageMinutes, 180);
});

test('health.io-main-shouts.answered-or-young-none: clause 2: an answered shout, a young one and one from the coordinator give no finding [C7]', t => {
  const { stuck } = report(t, [
    ['core-1', 'coordinator', 'answered blocker', 5],
    ['coordinator', 'core-1', 'the answer', 4, 1],
    ['core-2', 'coordinator', 'a young blocker', 0.2],
    ['coordinator', 'core-3', 'coordinator to a seat', 6],
  ]);
  assert.deepEqual(stuck.filter(row => row.cause === 'SHOUT_UNANSWERED'), []);
});

test('health.io-main-shouts.health-lines: clause 3: healthLines prints the SHOUT_UNANSWERED finding the report holds [C7]', t => {
  const lines = healthLines(report(t, [['core-1', 'coordinator', 'blocked on the schema', 3, null, 77]]));
  assert.ok(lines.some(line => line.includes('shout #1 from core-1 about #77') && line.includes('unanswered shout to the coordinator')), lines.join('\n'));
});
