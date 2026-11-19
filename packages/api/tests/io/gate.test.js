/** A land job that could not merge an accepted item under separate publish gives it back for a main merge, keeping its accept; a red or hook-refused one still holds [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';

const STAMP = '2026-11-16T12:00:00.000Z';
const MAIN = 'a'.repeat(40);
const TRUNK = 'b'.repeat(40);

/** A board with item 7 accepted at MAIN (its accept recorded), built by core-1, and one claimed separate-publish land job offered for it. */
function landing(t) {
  const board = cellBoard(t, ':memory:');
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (7, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run(MAIN, 'd'.repeat(64), MAIN, STAMP);
  board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)').run(STAMP, 'core-2', 'accept', 7, JSON.stringify({ commit: MAIN }));
  board.db.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run('coordinator', 'core', '/seat/coordinator', 'strong', STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status='verified', item_commit=?, item_owner='core-1', item_lease_until='2099-01-01T00:00:00.000Z', item_frozen_digest=?, item_built_by='core-1', item_verified_by='core-2', item_verdict='ACCEPT' WHERE item_id=7`)
    .run(MAIN, 'd'.repeat(64));
  board.db.exec('DELETE FROM temp.moving');
  offerJob(board.db, { id: 'land:1:k', kind: 'land', base: MAIN, needs: [], payload: { items: [{ id: 7 }], publish: 'separate' }, now: 1 });
  const held = claimJob(board.db, { runner: 'r-land', capabilities: [], now: 2 });
  const post = receipt => boardJobQueueCall(board, { action: 'receipt', job: 'land:1:k', runner: 'r-land', token: held.token, receipt }, { mode: 'pull', now: 3 });
  return { board, post };
}

const row = board => board.db.prepare('SELECT item_status, item_hold_at FROM item WHERE item_id = 7').get();
const notes = board => board.db.prepare("SELECT event_kind, event_detail FROM event WHERE item_id = 7 AND event_kind <> 'accept'").all().map(event => `${event.event_kind} ${event.event_detail}`).join(' | ').slice(0, 800);
const events = (board, kind) => board.db.prepare('SELECT event_detail FROM event WHERE item_id = 7 AND event_kind = ?').all(kind).map(event => JSON.parse(event.event_detail));

test('api.gate.land-conflict-reopens-for-merge: clause 1: a separate-publish land job that could not merge an accepted item reopens it for a main merge naming the conflicting files, keeps its accept recorded, leaves no hold, and shouts its builder [C7]', t => {
  const { board, post } = landing(t);
  post({ kind: 'land', outcome: 'returned', base: TRUNK, trunk: null, landed: [], already: [],
    returned: [{ id: 7, reason: 'conflict', detail: 'CONFLICT (content): Merge conflict in packages/a.js\nCONFLICT (content): Merge conflict in packages/b.js\nAutomatic merge failed' }] });
  const after = row(board);
  assert.equal(after.item_hold_at, null, 'no hold');
  const why = notes(board);
  assert.notEqual(after.item_status, 'verified', `the item went back to its builder: ${why}`);
  assert.equal(events(board, 'accept').length, 1, 'its accept stays recorded');
  const [reopen] = events(board, 'reopen');
  assert.deepEqual(reopen.conflict?.files ?? reopen.files, ['packages/a.js', 'packages/b.js'], 'the reopen names the conflicting files');
  const shouts = board.db.prepare('SELECT shout_to, shout_text FROM shout').all();
  assert.ok(shouts.some(shout => shout.shout_to === 'core-1' && /#7 is back with you/u.test(shout.shout_text)), 'its builder is shouted');
});

test('api.gate.land-red-under-separate-still-holds: clause 2: a red or hook-refused land job under separate publish still holds the accepted item [C7]', t => {
  for (const reason of ['red', 'hook']) {
    const { board, post } = landing(t);
    post({ kind: 'land', outcome: 'returned', base: TRUNK, trunk: null, landed: [], already: [], returned: [{ id: 7, reason, detail: 'test failed: a.test.js' }] });
    const after = row(board);
    assert.equal(after.item_status, 'verified', `${reason} keeps the item accepted`);
    assert.ok(after.item_hold_at, `${reason} parks it on a hold: ${notes(board)}`);
    assert.equal(events(board, 'reopen').length, 0);
  }
});
