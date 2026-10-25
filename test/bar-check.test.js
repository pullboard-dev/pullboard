/** Prove the opt-in bar check's claim-scoped typed note and one-session answer [B29,B30,B31,H16]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { barCheckState, barCheckWarning } from '../src/bar-check.js';
import { parentSessionDigest } from '../src/parent-session.js';
import { saveAgentSession } from '../src/seats.js';
import { applyRelayMove, prepareEngineMove } from '../src/engine.js';
import { BAR_CHECK_ENGINE } from '../src/bar-check-engine.js';
import { ENGINE_VERSION } from '../src/engine-metadata.js';
import { createE2eHelpers } from './e2e-helpers.js';

const HOUR = 3_600_000;
const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Open a private board and enroll two agents with distinct recorded runtime sessions. */
function fixture(t, route = 'mid') {
  const board = store.openBoard(':memory:');
  store.register(board, { lane: 'coordinator', path: '/fixture/main' });
  store.register(board, { lane: 'core', path: '/fixture/builder' });
  store.register(board, { lane: 'core', path: '/fixture/reviewer' });
  saveAgentSession(board, 'core-1', parentSessionDigest('bar-check-builder-session'));
  saveAgentSession(board, 'core-2', parentSessionDigest('bar-check-reviewer-session'));
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Bar check fixture', criterion: 'the bar is understood', route,
    brief: 'Files: src/page.js\nTest: the check proves the criterion', check: 'true' });
  t.after(() => store.closeBoard(board));
  return { board, id };
}

/** Record an opt-in setting with the required measured window. */
function enable(board) {
  store.setLineSetting(board, { agentId: 'coordinator', key: 'bar.check', value: true,
    reason: 'The review window needs a pre-build bar check', window: { windowMinutes: 60, activeReviewers: 2 } });
}

/** Claim an item with a stable fixture criterion digest. */
function claim(board, id) {
  return store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 2 * HOUR,
    freeze: item => ({ text: item.item_criterion, digest: 'fixture-bar-check' }) });
}

const BUILDER_NOTE = 'bar: the criterion is met by the changed behavior\nedge cases: empty and repeated inputs\ntest: add one named case for each';

test('[B29,B30,B31,H16] a bar check note on a claimed item is answered by a reviewer in one round', t => {
  const { board, id } = fixture(t);
  assert.equal(store.lineSettings(board)['bar.check'], false, 'the board setting is off by default');
  assert.equal(barCheckWarning(board, store.getItem(board, id)), null, 'unclaimed work has no current bar-check cycle');
  enable(board);
  claim(board, id);
  const item = store.getItem(board, id);
  const note = store.appendFact(board, id, { agentId: 'core-1', kind: 'bar-check', text: BUILDER_NOTE, factId: 'builder-bar-check' });
  assert.equal(note.claimId, store.events(board, { itemId: id }).findLast(event => event.event_kind === 'claim').event_id);
  assert.match(barCheckWarning(board, store.getItem(board, id)), /has no reviewer answer/u);
  assert.throws(() => store.appendFact(board, id, { agentId: 'core-1', kind: 'bar-answer', text: 'yes', answers: note.id }), { code: 'BAR_SELF_SIGN' });
  const answer = store.appendFact(board, id, { agentId: 'core-2', kind: 'bar-answer', text: 'The repeated input also needs to preserve order.', answers: note.id, factId: 'reviewer-bar-answer' });
  assert.equal(answer.answers, note.id, 'the answer names the note it reviewed');
  assert.equal(barCheckState(board, item).answer.id, answer.id);
  assert.equal(barCheckWarning(board, store.getItem(board, id)), null);
  assert.throws(() => store.appendFact(board, id, { agentId: 'core-2', kind: 'bar-answer', text: 'yes', answers: note.id }), { code: 'FACT_JUDGEMENT' });

  store.appendFact(board, id, { agentId: 'core-1', kind: 'bar-check', text: BUILDER_NOTE + '\nbar: correction for this claim', factId: 'builder-bar-check-correction' });
  assert.equal(barCheckState(board, store.getItem(board, id)).answer, null, 'a later note needs its own answer');
  assert.throws(() => store.appendFact(board, id, { agentId: 'core-2', kind: 'bar-answer', text: 'yes', answers: note.id }), { code: 'NO_FACT' });
});

test('[R2,H16] the bar.check setting refuses old engine moves and applies at its current engine floor', t => {
  const { board } = fixture(t);
  const options = { agentId: 'coordinator', key: 'bar.check', value: true, reason: 'the check is being introduced',
    window: { windowMinutes: 60, activeReviewers: 2 } };
  const move = prepareEngineMove(board, 'setLineSetting', [options], { id: 'bar-check-setting-engine', actor: 'coordinator' });
  assert.equal(move.engine, ENGINE_VERSION, 'new moves carry the current engine even after later features land');
  const envelope = { sequence: 1, at: '2026-10-24T00:00:00Z', kind: 'move',
    sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture' } };
  assert.throws(() => applyRelayMove(board, { ...move, engine: BAR_CHECK_ENGINE - 1 }, envelope),
    /RELAY_MOVE.*introduced in engine/u, 'an old engine cannot reinterpret the new setting');
  assert.equal(store.lineSettings(board)['bar.check'], false);
  assert.equal(applyRelayMove(board, { ...move, engine: BAR_CHECK_ENGINE }, envelope).error, undefined,
    'the historical bar-check floor still replays after later features land');
  assert.equal(store.lineSettings(board)['bar.check'], true);
});

test('[B29,B30,B31,H16] renewals keep the current note and a new claim starts a fresh bar-check round', t => {
  const { board, id } = fixture(t);
  enable(board);
  claim(board, id);
  const note = store.appendFact(board, id, { agentId: 'core-1', kind: 'bar-check', text: BUILDER_NOTE, factId: 'renew-note' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 2 * HOUR, freeze: () => ({ text: '', digest: '' }) });
  assert.equal(barCheckState(board, store.getItem(board, id)).note.id, note.id);
  store.release(board, id, 'core-1');
  claim(board, id);
  assert.equal(barCheckState(board, store.getItem(board, id)).note, null);
  assert.match(barCheckWarning(board, store.getItem(board, id)), /has no builder note/u);
});

test('[B29,B30,B31,V4,H16] submit succeeds despite a missing answer, warns once and records the warning', () => {
  const box = e2e.project();
  const added = box.run(box.repo, 'add', 'web', 'Bar check submit', '--route', 'mid', '--criterion', 'the page renders', '--check', 'true',
    '--brief', 'Files:\n- web/page.html\nTest:\n- the page renders');
  assert.equal(added.code, 0, added.err);
  const enabled = box.run(box.repo, 'settings', 'line', 'bar.check', 'on', '--reason', 'check the criterion before building',
    '--window', '{"windowMinutes":60,"activeReviewers":2}');
  assert.equal(enabled.code, 0, enabled.err);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  assert.equal(e2e.commitFile(box, box.web, 'web/page.html', '<h1>Page</h1>\n', 'feat(web): add page [G1]').status, 0);

  const submitted = box.run(box.web, 'submit', '1');
  assert.equal(submitted.code, 0, submitted.err);
  assert.match(submitted.out, /^bar\.check warning: bar\.check for claim \d+ has no builder note$/mu);
  assert.equal((submitted.out.match(/^bar\.check warning:/gmu) ?? []).length, 1, 'submit emits one warning line');
  assert.match(submitted.out, /submitted #1/u, 'the warning does not refuse submit');
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const warning = store.events(board, { itemId: 1 })
      .filter(event => event.event_kind === 'fact')
      .map(event => JSON.parse(event.event_detail))
      .find(fact => fact.kind === 'note' && fact.text.startsWith('bar.check warning:'));
    assert.ok(warning, 'the warning is recorded as an item fact');
    assert.match(warning.text, /^bar\.check warning: bar\.check for claim \d+ has no builder note$/u);
  } finally { store.closeBoard(board); }
});

test('[B29,B30,B31,V4,H16] a sent-back light item starts a required check when it is reclaimed', () => {
  const box = e2e.project();
  const added = box.run(box.repo, 'add', 'web', 'Light bar check', '--route', 'light', '--criterion', 'the page renders', '--check', 'true',
    '--brief', 'Files:\n- web/page.html\nTest:\n- the page renders');
  assert.equal(added.code, 0, added.err);
  const enabled = box.run(box.repo, 'settings', 'line', 'bar.check', 'on', '--reason', 'check the criterion before building',
    '--window', '{"windowMinutes":60,"activeReviewers":2}');
  assert.equal(enabled.code, 0, enabled.err);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  assert.equal(e2e.commitFile(box, box.web, 'web/page.html', '<h1>Page</h1>\n', 'feat(web): add page [G1]').status, 0);
  const firstSubmit = box.run(box.web, 'submit', '1');
  assert.equal(firstSubmit.code, 0, firstSubmit.err);
  assert.doesNotMatch(firstSubmit.out, /^bar\.check warning:/mu, 'a first light claim is optional');
  const reviewer = join(box.dir, 'web-reviewer');
  const submittedCommit = box.git(box.web, 'rev-parse', 'HEAD');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submittedCommit);
  const reviewerJoin = box.run(reviewer, 'join', 'web');
  assert.equal(reviewerJoin.code, 0, reviewerJoin.err);
  const rejected = box.run(reviewer, 'verify', '1', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--note', 'the heading is not specified');
  assert.equal(rejected.code, 0, rejected.err);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);

  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.equal(barCheckState(board, store.getItem(board, 1)).required, true,
      'the real reject and reclaim starts a fresh required check');
  } finally { store.closeBoard(board); }
});
