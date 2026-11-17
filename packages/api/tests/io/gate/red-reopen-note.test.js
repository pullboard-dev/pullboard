/** A land job's reopen note tells a builder to fix and resubmit when the merged tree went red, and to merge main only when the job could not merge [C7,U159]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellSandbox } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { applyLandingReceipt } from '../../../src/io/gate.js';
import { offerLandingJob } from '../../../index.js';

const STAMP = '2026-11-16T12:00:00.000Z';
const MAIN = 'a'.repeat(40);
const CONFIG = { trunk: { remote: '/trunk.git' } };

/** A file board with item 7 accepted and one landing offered for it, the receipt applied, and the reopen note the builder reads. */
function noteAfter(t, receipt) {
  const board = cellBoard(t, join(cellSandbox(t).dir, 'board.sqlite'), undefined, { real: true });
  cellSeat(board, { lane: 'coordinator', path: '/fixture/coordinator' });
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (7, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run(MAIN, 'd'.repeat(64), MAIN, STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status='verified', item_commit=?, item_owner='core-1', item_lease_until='2099-01-01T00:00:00.000Z', item_frozen_digest=?, item_built_by='core-1', item_verified_by='core-2', item_verdict='ACCEPT' WHERE item_id=7`)
    .run(MAIN, 'd'.repeat(64));
  board.db.exec('DELETE FROM temp.moving');
  const job = offerLandingJob(board.db, { items: [{ id: 7, commit: MAIN, ref: 'refs/pullboard/land/7' }], expect: MAIN, config: CONFIG });
  const answer = applyLandingReceipt(board, { job: job.id, receipt }, {});
  const rows = board.db.prepare("SELECT event_detail FROM event WHERE item_id = 7 AND event_kind = 'reopen' ORDER BY event_id").all();
  const all = board.db.prepare('SELECT event_kind, event_detail FROM event WHERE item_id = 7 ORDER BY event_id').all().map(row => row.event_kind + ' ' + row.event_detail).join('\n');
  return { answer, all, note: rows.map(row => JSON.parse(row.event_detail).note).join('\n') };
}

test('api.gate-red-reopen-note.red-tree-fix-and-resubmit: clause 1: the reopen note of a land job that checked the merged tree red says fix it, commit and resubmit, with no "merge current main" [C7,U159]', t => {
  const { answer, note, all } = noteAfter(t, { outcome: 'red', detail: 'test failed: a.test.js', returned: [{ id: 7, reason: 'red', detail: 'test failed: a.test.js' }] });
  assert.deepEqual(answer.returned, [7], all);
  assert.match(note, /fix it, commit and resubmit \(submit composes current main\)/u);
  assert.doesNotMatch(note, /merge current main/u);
});

test('api.gate-red-reopen-note.red-tree-names-failure: clause 2: the red note still names the land job and the first failing line, and a land job that could not merge still says merge current main and resolve [C7,U159]', t => {
  const red = noteAfter(t, { outcome: 'red', detail: 'test failed: a.test.js', returned: [{ id: 7, reason: 'red', detail: 'test failed: a.test.js' }] });
  assert.match(red.note, /checked the merged tree red: test failed: a\.test\.js/u);
  const conflict = noteAfter(t, { outcome: 'conflict', detail: 'CONFLICT in a.js', returned: [{ id: 7, reason: 'conflict', detail: 'CONFLICT in a.js' }] });
  assert.match(conflict.note, /could not merge it: CONFLICT in a\.js/u);
  assert.match(conflict.note, /merge current main, resolve the conflict, commit and resubmit/u);
});
