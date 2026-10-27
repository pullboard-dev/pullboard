/** @pullboard-test-loads src/board.js src/machine.js */
/** A missing frozen-clause quote must refuse the real rejection before mutation [V6,R2,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { submitFixture } from './board-submit-fixture.js';

const CRITERION = 'The page renders its title. The page renders its footer.';

/** Freeze the actual criterion independently of any unrecovered clause implementation. */
function freeze() {
  return { text: JSON.stringify({ criterion: CRITERION, rows: [],
    policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }),
  digest: 'reject-clause-before-v1' };
}

test('rejects require a frozen clause before any verdict mutation [V6,R2,H16]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-reject-clause-'));
  const board = store.openBoard(join(directory, 'board.sqlite'));
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: '/reject-clause/main' });
  const builder = store.register(board, { lane: 'web', path: '/reject-clause/builder', route: 'strong' });
  const reviewer = store.register(board, { lane: 'web', path: '/reject-clause/reviewer', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Render the page',
    criterion: CRITERION, check: 'true', route: 'mid',
    brief: 'Files: web/page.html\nTest: assert the rendered title and footer.' });
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
  const head = 'a'.repeat(40);
  // This is board-state setup, not a claim that a synthetic source tree ran a gate.
  submitFixture(board, id, { agentId: builder, commit: head, tree: head });
  store.reserveReview(board, id, { agentId: reviewer, leaseMs: 3_600_000, policy: 'any' });
  assert.equal(store.getItem(board, id).item_status, 'submitted');
  assert.equal(store.getItem(board, id).item_review_by, reviewer);
  assert.equal(store.verdictsFor(board, id).length, 0);
  const before = store.events(board);
  assert.throws(() => store.verify(board, id, { agentId: reviewer, decision: 'REJECT',
    reason: 'BEHAVIOR_MISMATCH', note: 'The rendered output omits the title.',
    head, digest: store.getItem(board, id).item_frozen_digest, policy: 'any' }),
  { code: 'BAR_CLAUSE_REQUIRED' }, 'a native rejection without a frozen clause must refuse');
  assert.deepEqual(store.events(board), before, 'refusal appends no verdict event or hold');
  assert.equal(store.verdictsFor(board, id).length, 0);
  assert.equal(store.getItem(board, id).item_status, 'submitted');
  assert.equal(store.getItem(board, id).item_review_by, reviewer);
});
