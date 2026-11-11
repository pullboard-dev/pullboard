/** Review requests bind to the frozen bar without changing older replay [V6,R2,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { REVIEW_REQUEST_ENGINE } from '../../../../packages/state/light.js';
import { moveArgs } from '../../../../packages/person/index.js';
import {
  applyRelayMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';

const criterion = 'The page renders its title. The page renders its footer.';
const clause = 'The page renders its title.';

/** Seed one actual review reservation on a frozen submitted item. */
function fixture(t) {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/request/main' });
  const builder = store.register(board, { lane: 'web', path: '/request/builder', route: 'strong' });
  const reviewer = store.register(board, { lane: 'web', path: '/request/reviewer', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Render the page', criterion,
    check: 'true', route: 'mid', brief: 'Files: web/page.html\nTest: assert the title and footer.' });
  const freeze = () => ({ text: JSON.stringify({ criterion, check: 'true', rows: [],
    policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'request-bar' });
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
  submitFixture(board, id, { agentId: builder, commit: 'a'.repeat(40), tree: 'a'.repeat(40) });
  store.reserveReview(board, id, { agentId: reviewer, lane: 'web', leaseMs: 3_600_000, policy: 'any' });
  return { board, builder, reviewer, id };
}

test('a reviewer request to a builder without a bar clause is refused [V6,R2,H16]', t => {
  const { board, builder, reviewer, id } = fixture(t);
  const message = { from: reviewer, to: builder, item: id, lanes: ['web'], kind: 'request', text: 'Please fix the title.' };
  assert.throws(() => store.shout(board, message), { code: 'BAR_CLAUSE_REQUIRED' });
  assert.throws(() => store.shout(board, { ...message, clause: 'An invented requirement' }), { code: 'BAR_CLAUSE_UNKNOWN' });
  const sent = store.shout(board, { ...message, clause });
  assert.ok(sent > 0, 'a real frozen clause permits the request');
  assert.match(store.getShout(board, sent).shout_text, /Bar: The page renders its title\./u, 'the builder sees the quoted clause');
  assert.ok(store.shout(board, { ...message, kind: 'question' }) > 0, 'ordinary questions do not need a clause');
  board.executionEngineVersion = REVIEW_REQUEST_ENGINE - 1;
  assert.ok(store.shout(board, { ...message, kind: undefined }) > 0, 'older untyped item messages retain their meaning');
  delete board.executionEngineVersion;
  assert.ok(store.shout(board, { ...message, item: undefined, text: `Please fix the title in #${id} before the next review.`, clause: 'true' }) > 0, 'a direct builder request may quote the frozen check');
});

test('a send-back may quote its frozen check [V6,R2,H16]', t => {
  const { board, reviewer, id } = fixture(t);
  const result = store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE',
    note: 'The frozen check failed.', clause: 'true', head: 'a'.repeat(40),
    digest: 'request-bar', policy: 'any' });
  assert.equal(result.clause, 'true');
});

test('review request arguments preserve the literal bar quote [V6,A2,H16]', () => {
  const args = moveArgs({ verb: 'shout', args: { to: 'web-1', text: 'Please repair #1 title.', kind: 'request', clause } });
  assert.ok(args.includes('--kind=request'));
  assert.ok(args.includes(`--clause=${clause}`));
});

test('the CLI sends a quoted reviewer request through the ordered board [V6,A2,H16]', t => {
  const box = crossLaneFixture(t);
  const builder = box.seat('request-builder', 'web', 'request-builder-session');
  const reviewer = box.seat('request-reviewer', 'api', 'request-reviewer-session');
  const id = box.add('web', 'Render the title');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    const freeze = () => ({ text: JSON.stringify({ criterion, check: 'true', rows: [],
      policy: { version: 1, commit: box.git(box.repo, 'rev-parse', 'HEAD').trim(), verify: { policy: 'any', family: 'off' } } }), digest: 'cli-request-bar' });
    store.claim(board, id, { agentId: builder.agent, lane: 'web', leaseMs: 3_600_000, freeze });
    submitFixture(board, id, { agentId: builder.agent, commit: box.git(box.repo, 'rev-parse', 'HEAD').trim(), tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}').trim() });
    store.reserveReview(board, id, { agentId: reviewer.agent, lane: 'api', leaseMs: 3_600_000, policy: 'any' });
  } finally { store.closeBoard(board); }
  const missing = box.runAs('request-reviewer-session', reviewer.root, 'shout', '--item', String(id), 'Please repair the title.', '--kind', 'request', '--json');
  assert.equal(missing.code, 1, missing.err + missing.out);
  assert.equal(JSON.parse(missing.out).error.code, 'BAR_CLAUSE_REQUIRED');
  const accepted = box.runAs('request-reviewer-session', reviewer.root, 'shout', '--item', String(id), 'Please repair the title.', '--kind', 'request', '--clause', clause, '--json');
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  const after = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try { assert.match(store.getShout(after, JSON.parse(accepted.out).id).shout_text, /Bar: The page renders its title\./u); }
  finally { store.closeBoard(after); }
});


test('new request and check-only reject semantics cannot replay under an older engine [H16,V6]', t => {
  const { board, reviewer, builder, id } = fixture(t);
  const moves = [
    prepareEngineMove(board, 'shout', [{ from: reviewer, to: builder, item: id, lanes: ['web'], kind: 'request', text: 'Fix the title.', clause }], { actor: reviewer }),
    prepareEngineMove(board, 'shout', [{ from: reviewer, to: builder, item: id, lanes: ['web'], kind: 'question', text: 'What happened?' }], { actor: reviewer }),
    prepareEngineMove(board, 'verify', [id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', clause: 'true', note: 'check failed' }], { actor: reviewer }),
  ];
  for (const move of moves) {
    assert.throws(() => applyRelayMove(board, { ...move, engine: REVIEW_REQUEST_ENGINE - 1 }, {
      sequence: 1, at: '2026-11-02T00:00:00Z', kind: 'move',
      sender: { kind: 'agent', userId: 'fixture', agent: reviewer },
    }), /RELAY_MOVE/);
  }
});
