/** A worktree seat declares the family its model's tier names [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { openBoard } from '../../../lib/index.js';
import { reviewEligibility } from '../../../../packages/verify/index.js';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';

test('clause 1: a worktree command records the family from the canonical model-tier table [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const created = box.run(box.repo, 'worktree', 'web', '--model', 'claude-sonnet-5-5', '--json');
  assert.equal(created.code, 0, created.err || created.out);
  const result = JSON.parse(created.out);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const seat = store.agentAt(board, result.path);
    assert.equal(seat.agent_model, 'claude-sonnet-5-5');
    assert.equal(seat.agent_family, 'anthropic', 'known model tiers declare their canonical family when the worktree is registered');
  } finally { board.db.close(); }
});

test('an unfamiliar model label declares no family [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const created = box.run(box.repo, 'worktree', 'web', '--model', 'some-unknown-model', '--json');
  assert.equal(created.code, 0, created.err || created.out);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.ok(!store.agentAt(board, JSON.parse(created.out).path).agent_family);
  } finally { board.db.close(); }
});

test('clause 2: a submit without usage lists reviewers by the builder seat family [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.register(board, { id: 'coordinator', lane: 'coordinator', path: box.repo, family: 'person-family', model: 'fixture model' });
    store.register(board, { id: 'core-1', lane: 'core', path: join(box.dir, 'builder'), model: 'fixture model' });
    store.register(board, { id: 'core-2', lane: 'core', path: join(box.dir, 'same-family'), family: 'vendor-a', model: 'fixture model' });
    store.register(board, { id: 'core-3', lane: 'core', path: join(box.dir, 'other-family'), family: 'vendor-b', model: 'fixture model' });
    const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Declared review family', criterion: 'Prove family eligibility' });
    store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
      freeze: () => ({ text: JSON.stringify({ policy: { verify: { policy: 'any' } } }), digest: 'f'.repeat(64) }) });
    submitFixture(board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
    assert.equal(store.getItem(board, id).item_builder_family, null, 'the synthetic submit has no usage-family snapshot');
    store.register(board, { id: 'core-1', lane: 'core', path: join(box.dir, 'builder'), family: 'vendor-a', model: 'fixture model' });
    const eligibility = reviewEligibility(board, store.getItem(board, id), { policy: 'any', familyPolicy: 'require' });
    assert.ok(eligibility.eligible.includes('core-3'), 'a different declared family is eligible');
    assert.ok(!eligibility.eligible.includes('core-2'), 'the builder family is excluded');
  } finally { store.closeBoard(board); }
});
