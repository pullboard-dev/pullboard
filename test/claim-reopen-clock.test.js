import { requireFixtureReviewFamilies } from './review-family-fixture.js';
/** @pullboard-test-loads src/board.js src/claims.js */
/** Advancing clocks preserve the entire opt-in builder window [B13,B5]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { submitFixture } from './board-submit-fixture.js';

const COMMIT = 'a'.repeat(40);
const TRUNK = 'b'.repeat(40);
/** Open a real SQLite board with a clock advanced independently of the host. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-reopen-'));
  let at = Date.parse('2026-01-01T00:00:00Z');
  const board = store.openBoard(join(directory, 'board.sqlite'), { now: () => new Date(at) });
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const builder = store.register(board, { lane: 'core', path: '/builder', family: 'Fixture Clock Builder Vendor', route: 'mid' });
  const other = store.register(board, { lane: 'core', path: '/other', family: 'Fixture Clock Reviewer Vendor', route: 'mid' });
  requireFixtureReviewFamilies(board);
  return { board, directory, builder, other, advance: (minutes) => { at += minutes * 60_000; } };
}
/** Claim the item with a frozen bar and a bounded lease. */
function claim(f, id, agentId) {
  return store.claim(f.board, id, { agentId, lane: 'core', leaseMs: 7_200_000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit: COMMIT, verify: { policy: 'any', family: 'off' } } }), digest: 'digest:bar' }) });
}
/** Submit and return an item through the real rejection, landing-failure or conflict path. */
function returned(f, cause, minutes, causeKey) {
  const id = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'fix', criterion: 'prove', specIds: ['B13'], route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves the fix' });
  claim(f, id, f.builder);
  submitFixture(f.board, id, { agentId: f.builder, commit: COMMIT, tree: COMMIT });
  const verdict = { agentId: f.other, head: COMMIT, digest: 'digest:bar', policy: 'any', note: 'proof', ...(causeKey ? { cause: causeKey } : {}) };
  if (cause === 'reject') store.verify(f.board, id, { ...verdict, decision: 'REJECT', reason: 'OTHER', clause: 'prove', reopenFirstRefusalMinutes: minutes });
  else {
    store.verify(f.board, id, { ...verdict, decision: 'ACCEPT' });
    store.reopen(f.board, id, { agentId: 'coordinator', reopenFirstRefusalMinutes: minutes, ...(causeKey ? { cause: causeKey } : {}),
      ...(cause === 'conflict' ? { conflict: { files: ['src/a.js'], trunk: TRUNK } }
        : { note: `test/a.test.js: failed case; merge commit ${TRUNK}` }) });
  }
  return id;
}

test('[B13,B5] every return anchors its full builder window to one advancing-clock instant', t => {
  for (const cause of ['reject', 'landing', 'conflict']) {
    for (const stepMs of [1, 1000]) {
      const f = fixture(t);
      let instant = Date.parse('2026-01-01T00:00:00Z');
      f.board.clock = { now: () => { const at = new Date(instant); instant += stepMs; return at; } };
      const id = returned(f, cause, 30);
      const event = store.events(f.board, { itemId: id }).findLast(row => row.event_kind === (cause === 'reject' ? 'reject' : 'reopen'));
      const window = JSON.parse(event.event_detail).reopenFirstRefusal;
      assert.equal(Date.parse(window.until) - Date.parse(event.event_at), 30 * 60_000, `${cause}/${stepMs}`);
      assert.equal(store.recentShouts(f.board).filter(row => row.shout_to === f.builder && row.shout_text.includes('waits for you')).length, 1);
      instant = Date.parse(window.until) - 1;
      f.board.clock = { now: () => new Date(instant) };
      assert.throws(() => claim(f, id, f.other), error => error.code === 'REOPEN_HELD_FOR_BUILDER');
      instant += 1;
      claim(f, id, f.other);
      assert.equal(store.getItem(f.board, id).item_owner, f.other);
    }
  }
});
