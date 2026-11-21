// fixture-subject: addItem (a unit test of the rank-inversion finding over seeded claims and rejected items; the board is opened through the fixture kit)
/** The sentinel flags a fresh claim ranked behind free work, never a builder reworking its own rejected item [C7,B13]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { submitFixture } from '../../../../store/tests/fixtures/submit.js';
import { healthReport } from '../../../index.js';

const COMMIT = 'a'.repeat(40);

/** Claim an item as the seat, with the frozen bar the board needs at claim time. */
function claim(board, id, agentId) {
  return store.claim(board, id, { agentId, lane: 'core', leaseMs: 60 * 60_000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'fixture-bar' }) });
}

/** One board: an untouched open item ranked ahead, a builder seat, a reviewer seat, and a later item the builder takes. */
function fixture(t) {
  const board = fixtureBoard(t, { clock: { now: () => new Date('2026-11-19T10:00:00.000Z') } });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const builder = store.register(board, { lane: 'core', path: '/builder', route: 'mid', family: 'Claude' });
  const reviewer = store.register(board, { lane: 'core', path: '/reviewer', route: 'mid', family: 'OpenAI' });
  const add = title => store.addItem(board, { by: 'coordinator', lane: 'core', title, criterion: 'prove it', specIds: ['B13'], route: 'mid',
    check: 'true', brief: 'Files: src/rank.js\nTest: ranks' });
  const ahead = add('untouched open work');
  const behind = add('work the builder takes');
  return { board, builder, reviewer, ahead, behind };
}

/** The report's RANK_INVERSION findings at the board clock. */
function inversions(board) {
  const report = healthReport({ db: board.db, root: process.cwd(), config: {}, now: board.clock.now(), dispatchHealth: () => ({ findings: [] }) });
  return report.stuck.filter(row => row.cause === 'RANK_INVERSION');
}

test('health.io-main-rank-inversion.own-rework-exempt: clause 1: a builder holding a live claim on its own rejected item gives no RANK_INVERSION finding while open work ranks ahead [C7,B13]', t => {
  const f = fixture(t);
  claim(f.board, f.behind, f.builder);
  submitFixture(f.board, f.behind, { agentId: f.builder, commit: COMMIT, tree: COMMIT });
  store.verify(f.board, f.behind, { agentId: f.reviewer, decision: 'REJECT', reason: 'OTHER', note: 'needs one fix', clause: 'prove it', head: COMMIT, digest: 'fixture-bar', policy: 'any' });
  claim(f.board, f.behind, f.builder);
  assert.equal(store.getItem(f.board, f.behind).item_status, 'claimed');
  assert.equal(store.getItem(f.board, f.ahead).item_status, 'open');
  assert.deepEqual(inversions(f.board), []);
});

test('health.io-main-rank-inversion.fresh-claim-still-flagged: clause 2: a builder claiming a never-rejected item while open work ranks ahead still gives one RANK_INVERSION finding naming both [C7,B13]', t => {
  const f = fixture(t);
  claim(f.board, f.behind, f.builder);
  const found = inversions(f.board);
  assert.equal(found.length, 1);
  assert.equal(found[0].item, f.behind);
  assert.equal(found[0].detail.ahead, f.ahead);
});
