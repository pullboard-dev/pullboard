/** Review queue depth, time to verdict and reject rate per reviewer family, from a seeded board [C7,#6138]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeBoard } from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureOpenBoard } from '../../tests/fixtures/testkit.js';

/** ISO time on the seeded day. */
const iso = (time) => `2026-10-12T${time}Z`;
const MINUTE = 60_000;

/** Seed six items with submits, a reservation, a release, verdicts of three families and one live reviewer reservation. */
function seed(db) {
  const item = db.prepare("INSERT INTO item(item_id,item_lane,item_title,item_created_by,item_created_at,item_updated_at) VALUES (?,?,?,?,?,?)");
  for (let id = 1; id <= 6; id++) item.run(id, 'core', `seeded ${id}`, 'coordinator', iso('00:00:00.000'), iso('00:00:00.000'));
  db.prepare("UPDATE item SET item_status='submitted', item_built_by='core-1', item_commit='c4', item_frozen_digest='d4', item_review_by='core-9', item_review_until=? WHERE item_id=4").run(iso('12:30:00.000'));
  const event = db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)');
  const put = (time, kind, id, detail = {}) => event.run(iso(time), 'core-1', kind, id, JSON.stringify(detail));
  put('07:30:00.000', 'submit', 5);
  put('07:50:00.000', 'release', 5);
  put('08:10:00.000', 'submit', 1);
  put('08:20:00.000', 'submit', 2);
  put('08:25:00.000', 'reserve', 2, { until: iso('09:25:00.000') });
  put('08:50:00.000', 'submit', 3);
  put('09:10:00.000', 'submit', 4);
  put('10:00:00.000', 'submit', 4);
  put('11:00:00.000', 'submit', 6);
  const verdict = db.prepare('INSERT INTO verdict(item_id,verdict_by,verdict_decision,verdict_reason,verdict_commit,verdict_digest,verdict_head,verdict_at,verdict_verifier_family) VALUES (?,?,?,?,?,?,?,?,?)');
  const judge = (id, time, decision, family) => verdict.run(id, 'core-7', decision, 'CRITERION_MET', 'c', 'd', 'h', iso(time), family);
  judge(1, '08:40:00.000', 'ACCEPT', 'claude');
  judge(2, '09:20:00.000', 'REJECT', 'openai');
  judge(3, '10:50:00.000', 'ACCEPT', 'openai');
  judge(4, '09:40:00.000', 'REJECT', 'claude');
  judge(6, '11:20:00.000', 'ACCEPT', null);
}

test('stats review: seeded verdicts give exact queue depth by hour, time to verdict and reject rate per family [C7,#6138]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const board = fixtureOpenBoard({ boardFile: join(box.repo, '.git', 'pullboard', 'board.sqlite'), web: box.repo });
  try { seed(board.db); } finally { closeBoard(board); }
  const result = await box.runLocal(box.web, 'stats', 'review', '--window', '6h', '--until', iso('12:00:00.000'), '--json');
  assert.equal(result.code, 0, result.stderr);
  const { review } = JSON.parse(result.stdout);
  assert.deepEqual(review.queue, [
    { hour: iso('06:00:00.000'), depth: 0, peak: 0, reserved: 0 },
    { hour: iso('07:00:00.000'), depth: 0, peak: 1, reserved: 0 },
    { hour: iso('08:00:00.000'), depth: 0, peak: 2, reserved: 0 },
    { hour: iso('09:00:00.000'), depth: 2, peak: 3, reserved: 1 },
    { hour: iso('10:00:00.000'), depth: 2, peak: 2, reserved: 0 },
    { hour: iso('11:00:00.000'), depth: 1, peak: 2, reserved: 0 },
  ]);
  assert.deepEqual(review.toVerdict, { samples: 5, p50Ms: 30 * MINUTE, p90Ms: 120 * MINUTE, maxMs: 120 * MINUTE });
  assert.deepEqual(review.families, [
    { family: 'claude', verdicts: 2, accepts: 1, rejects: 1, rejectRate: 0.5, toVerdict: { samples: 2, p50Ms: 30 * MINUTE, p90Ms: 30 * MINUTE, maxMs: 30 * MINUTE } },
    { family: 'openai', verdicts: 2, accepts: 1, rejects: 1, rejectRate: 0.5, toVerdict: { samples: 2, p50Ms: 60 * MINUTE, p90Ms: 120 * MINUTE, maxMs: 120 * MINUTE } },
    { family: 'unknown', verdicts: 1, accepts: 1, rejects: 0, rejectRate: 0, toVerdict: { samples: 1, p50Ms: 20 * MINUTE, p90Ms: 20 * MINUTE, maxMs: 20 * MINUTE } },
  ]);
  assert.deepEqual(review.reservedNow, [{ item: 4, by: 'core-9', until: iso('12:30:00.000') }]);
});

test('stats review: text names each family and the deepest hour [C7,#6138]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const board = fixtureOpenBoard({ boardFile: join(box.repo, '.git', 'pullboard', 'board.sqlite'), web: box.repo });
  try { seed(board.db); } finally { closeBoard(board); }
  const text = await box.runLocal(box.web, 'stats', 'review', '--window', '6h', '--until', iso('12:00:00.000'));
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /openai: 2 verdicts, 1 rejected \(50\.0%\); p50 3600\.0s p90 7200\.0s/u);
  assert.match(text.stdout, /queue: 6 hours; deepest 3 in the hour of 2026-10-12T09:00:00\.000Z; 1 items reserved at the end/u);
});
