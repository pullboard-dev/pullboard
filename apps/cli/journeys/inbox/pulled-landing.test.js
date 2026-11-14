/** A new board's first pulled landing leaves no batch receipt; every seat's inbox still reads [C7,B3,R2]. */
// fixture-subject: addItem (activity projection over seats registered in an in-memory board)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';

/** One main-moved receipt as a pulled landing writes it: a land job, no batch. */
function pulledLanding(board, detail) {
  board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), 'coordinator', 'main-moved', null, JSON.stringify(detail));
}

test('a seat reads its inbox after a new board first pulled landing, with no landing batch recorded [C7]', t => {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/pulled/root' });
  const seat = store.register(board, { lane: 'web', path: '/pulled/web', session: 'pulled-web' });
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='landing_batch'").get().n, 0, 'a new board has no landing batch');
  const base = 'b'.repeat(40);
  const sha = 'c'.repeat(40);
  offerJob(board.db, { id: 'land-1', kind: 'land', base });
  pulledLanding(board, { sha, job: 'land-1', items: [1] });
  const seen = [];
  const feed = store.agentActivity(board, seat, { after: 0, workingFiles: ['src/a.js'],
    changesForMain: (commit, detail) => { seen.push({ commit, base: detail.base }); return ['src/a.js']; } });
  assert.deepEqual(seen, [{ commit: sha, base }], 'the land job records the main the landing moved from');
  assert.equal(feed.cursor > 0, true, 'the read completes with a cursor');
});

test('a pulled landing whose job is gone reads as unknown overlap, not a crash [C7]', t => {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/pulled/root' });
  const seat = store.register(board, { lane: 'web', path: '/pulled/web', session: 'pulled-web' });
  pulledLanding(board, { sha: 'd'.repeat(40), job: 'gone', items: [] });
  pulledLanding(board, { sha: 'e'.repeat(40), items: [] });
  const bases = [];
  store.agentActivity(board, seat, { after: 0, workingFiles: ['src/a.js'],
    changesForMain: (_commit, detail) => { bases.push(detail.base); return null; } });
  assert.deepEqual(bases, [null, null]);
});
