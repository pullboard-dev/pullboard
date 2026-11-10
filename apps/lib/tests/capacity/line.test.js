/** Capacity uses real SQLite lifecycle observations and versioned claims, not modelled permanent seat roles [N2,B13,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { submitFixture } from '../../../cli/tests/fixtures/board/submit.js';
import { lineCapacitySnapshot } from '../../../../packages/seats/index.js';
import { LINE_CAPACITY_ENGINE } from '../../../../packages/state/light.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { appliedSequence } from '../../../../packages/state/index.js';
import { replayHistoricalSeatMove } from '../../../cli/tests/fixtures/seats.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';

const HOUR = 3_600_000;
const FREEZE = () => ({ text: 'private lifecycle bar', digest: 'private-lifecycle-bar' });
/** Create one real board with explicit actor identities and an adjustable observation clock. */
function fixture(t, historicalSeats = false) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-line-capacity-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: 'any', lanes: { core: { owns: ['src/'], specs: [] } } }));
  git('add', 'pullboard.json');
  git('commit', '-q', '-m', 'fixture: establish board policy');
  let at = Date.parse('2026-10-24T00:00:00Z');
  const clock = { now: () => new Date(at) };
  const board = openBoard(join(root, 'board.sqlite'), clock, { gitRoot: root });
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  /** Keep current fixtures current; only the legacy-claim case receives actual pre-feature joins. */
  const register = who => historicalSeats
    ? replayHistoricalSeatMove(board, LINE_CAPACITY_ENGINE - 1, 'register', [who])
    : store.register(board, who);
  register({ lane: 'coordinator', path: root });
  const author = register({ lane: 'core', path: join(root, 'author'), route: 'strong', parent: 'A', session: 'a' });
  const reviewer = register({ lane: 'core', path: join(root, 'reviewer'), route: 'strong', parent: 'R', session: 'r' });
  /** Record normal private claims without asserting a gate execution. */
  function claim(id, agentId = author, options = {}) {
    return store.claim(board, id, { agentId, lane: 'core', leaseMs: HOUR, freeze: FREEZE, ...options });
  }
  /** Seed a submitted lifecycle through its normal moves. */
  function submit(title = 'waiting') {
    const id = store.addItem(board, { by: 'coordinator', lane: 'core', title });
    claim(id);
    submitFixture(board, id, { agentId: author, commit: String(id).padStart(40, 'a'), tree: String(id).padStart(40, 'b') });
    return id;
  }
  /** Change one recorded board input, leaving machine settings untouched. */
  function setting(key, value) {
    return store.setLineSetting(board, { agentId: 'coordinator', key, value, reason: 'private capacity proof', window: { activeReviewers: 1 } });
  }
  return { board, root, author, reviewer, claim, submit, setting, advance: ms => { at += ms; } };
}

test('capacity counts distinct review actors in the same bounded flow window, not their lane [N2,H16]', t => {
  const f = fixture(t), first = f.submit('first'), second = f.submit('second');
  assert.equal(lineCapacitySnapshot(f.board).activeReviewers, 1, 'no observations retains the denominator floor');
  store.reserveReview(f.board, first, { agentId: f.reviewer, leaseMs: HOUR, policy: 'any' });
  store.reserveReview(f.board, first, { agentId: f.reviewer, leaseMs: HOUR, policy: 'any' });
  store.reserveReview(f.board, second, { agentId: 'coordinator', leaseMs: HOUR, policy: 'any' });
  assert.equal(lineCapacitySnapshot(f.board).activeReviewers, 2, 'a core seat and coordinator are both observed reviewers; renewals do not duplicate them');
  f.advance(HOUR);
  assert.equal(lineCapacitySnapshot(f.board).activeReviewers, 2, 'the shared sixty-minute boundary is inclusive');
  f.advance(1);
  assert.equal(lineCapacitySnapshot(f.board).activeReviewers, 1, 'activity just outside the window expires');
  assert.equal(lineCapacitySnapshot(f.board, { windowMinutes: 180 }).activeReviewers, 2, 'the explicit flow window changes both bounds');
  assert.throws(() => lineCapacitySnapshot(f.board, { windowMinutes: Infinity }), { code: 'USAGE' });
});

test('WIP counts live claims and pending submissions, refuses atomically, and preserves renewals [N2,B13,H16]', t => {
  const f = fixture(t), waiting = f.submit();
  const a = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'one live claim' });
  const b = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'new claim' });
  f.claim(a);
  f.setting('wipPerReviewer', 1.5);
  const before = store.events(f.board).length;
  assert.throws(() => f.claim(b, f.reviewer), error => error.code === 'LINE_WIP_LIMIT' && error.message.includes(`#${waiting}`));
  assert.equal(store.events(f.board).length, before, 'a refused claim appends no history');
  assert.equal(store.getItem(f.board, b).item_frozen_digest, null);
  assert.equal(f.claim(a).renewed, true, 'a changed setting never strands a held claim');
  f.advance(HOUR + 1);
  assert.equal(lineCapacitySnapshot(f.board).wip, 1, 'an expired claim no longer consumes capacity');
  f.setting('wipPerReviewer', false);
  f.claim(b, f.reviewer);
  assert.equal(store.getItem(f.board, b).item_owner, f.reviewer, 'off restores ordinary claim behavior');
});

test('the offered oldest review respects the actual claim caller policy and author independence [N2,B13,H16]', t => {
  const f = fixture(t), waiting = f.submit();
  const id = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'blocked new work' });
  f.setting('wipPerReviewer', 1.5);
  assert.throws(() => f.claim(id, f.author), error => error.code === 'LINE_WIP_LIMIT' && !error.message.includes(`review oldest waiting item #${waiting}`));
  assert.throws(() => f.claim(id, f.reviewer, { reviewPolicy: 'coordinator' }), error => error.code === 'LINE_WIP_LIMIT' && !error.message.includes(`review oldest waiting item #${waiting}`));
});

test('old recorded claims ignore new capacity while new claims retain the feature floor on replay [N2,H16]', t => {
  const f = fixture(t, true); f.submit(); f.submit(); f.setting('wipPerReviewer', 1.5);
  const id = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'old recorded claim' });
  const snapshot = exportBoard(f.board);
  const options = { agentId: f.reviewer, lane: 'core', leaseMs: HOUR, freeze: FREEZE };
  const move = prepareEngineMove(f.board, 'claim', [id, options]);
  assert.equal(move.args[1].lineCapacity, true, 'newly prepared claims bind their new meaning explicitly');
  const legacy = structuredClone(move);
  delete legacy.args[1].lineCapacity;
  const sequence = appliedSequence(f.board) + 1;
  assert.throws(() => applyEngineMove(f.board, { ...move, engine: LINE_CAPACITY_ENGINE - 1 }, { sequence, at: f.board.clock.now().toISOString() }), { code: 'RELAY_MOVE' }, 'the true marker cannot be forged onto an older engine');
  const old = applyEngineMove(f.board, { ...legacy, engine: LINE_CAPACITY_ENGINE - 1 }, { sequence, at: f.board.clock.now().toISOString() });
  assert.equal(old.error, undefined, JSON.stringify(old.error));
  const replica = openBoard(join(f.root, 'replica.sqlite'), f.board.clock);
  t.after(() => store.closeBoard(replica));
  importBoard(replica, snapshot);
  const current = applyEngineMove(replica, move, { sequence, at: f.board.clock.now().toISOString() });
  assert.equal(current.error?.code, 'LINE_WIP_LIMIT');
  assert.equal(store.getItem(replica, id).item_status, 'open');
});

test('the total cap covers builds and submitted work together without rounding a fractional allowance [N2,R1,H16]', t => {
  const f = fixture(t), first = f.submit('first'), second = f.submit('second');
  store.reserveReview(f.board, first, { agentId: f.reviewer, leaseMs: HOUR, policy: 'any' });
  store.reserveReview(f.board, second, { agentId: 'coordinator', leaseMs: HOUR, policy: 'any' });
  f.setting('wipPerReviewer', 1.5);
  const third = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'third total item' });
  const fourth = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'fourth total item' });
  f.claim(third);
  assert.equal(lineCapacitySnapshot(f.board).wip, 3, 'two pending submissions and one live build consume the same cap');
  assert.throws(() => f.claim(fourth, f.reviewer), { code: 'LINE_WIP_LIMIT' });
  assert.equal(store.getItem(f.board, fourth).item_status, 'open');
});

test('legacy submissions without recorded submit history still consume native WIP [N2,H16]', t => {
  const f = fixture(t), waiting = f.submit();
  const original = store.events(f.board, { itemId: waiting });
  const legacy = exportBoard(f.board);
  // Model a legacy imported snapshot, preserving the original private board and all its receipts.
  legacy.tables.event = legacy.tables.event.filter(row => !(row.item_id === waiting && row.event_kind === 'submit'));
  const replica = openBoard(join(f.root, 'legacy.sqlite'), f.board.clock);
  t.after(() => store.closeBoard(replica));
  importBoard(replica, legacy);
  const snapshot = lineCapacitySnapshot(replica);
  assert.equal(snapshot.wip, 1);
  assert.equal(snapshot.pending[0].item_id, waiting);
  assert.equal(snapshot.pending[0].submitted_order, null, 'missing history is unknown, never an invented submit time');
  store.setLineSetting(replica, { agentId: 'coordinator', key: 'wipPerReviewer', value: 1.5, reason: 'legacy queue control', window: { activeReviewers: 1 } });
  const next = store.addItem(replica, { by: 'coordinator', lane: 'core', title: 'new work beside legacy submission' });
  assert.throws(() => store.claim(replica, next, { agentId: f.reviewer, lane: 'core', leaseMs: HOUR, freeze: FREEZE }),
    error => error.code === 'LINE_WIP_LIMIT' && error.message.includes('submit age unknown') && error.message.includes(`#${waiting}`));
  assert.deepEqual(store.events(f.board, { itemId: waiting }), original);
});
