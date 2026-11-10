/** Real Git/SQLite controls for an item's explicit reviewer family [V1,V2,B3,H16]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';

/** Exercise the real add/edit parser, shared eligibility and exact-seat dispatch without fabricating stored rows. */
export async function proveRequiredReviewFamily(t, { fixture, cli }) {
  const box = await fixture(t);
  const added = await cli(box, box.root, ['add', 'web', 'Review by a named family', '--criterion',
    'Only the explicitly required declared family reviews this item.', '--specs', 'G1', '--route', 'strong', '--check', 'true',
    '--review-family', 'Family Alpha', '--wait']);
  assert.equal(added.code, 0, added.out + added.err);
  const id = added.document.item.item_id;
  assert.equal(store.getItem(box.board, id).item_review_family, 'Family Alpha', 'add retains explicit item metadata');
  const edited = await cli(box, box.root, ['edit', String(id), '--review-family', 'fAmIlY bEtA']);
  assert.equal(edited.code, 0, edited.out + edited.err);
  assert.equal(store.getItem(box.board, id).item_review_family, 'fAmIlY bEtA', 'edit records the requested family spelling');
  box.submit(id);

  const unknownPath = join(box.root, '..', 'undeclared-reviewer');
  box.git(box.root, 'worktree', 'add', '-q', '-b', 'review/undeclared', unknownPath);
  const unknown = store.register(box.board, { lane: 'review', path: unknownPath, parent: 'fixture-unknown',
    model: 'claude-sonnet-5-5', route: 'strong' });
  const candidates = [box.seats.actor, box.seats.sameFamily, { id: unknown, path: unknownPath, lane: 'review' }];
  for (const seat of candidates) {
    const selected = store.nextFor(box.board, { agentId: seat.id, lane: seat.lane, verify: true,
      policy: 'any', familyPolicy: 'off' });
    assert.equal(selected.item, null, 'ordinary review selection cannot offer a wrong or undeclared family');
    assert.match(selected.reasons.join('\n'), /family beta/iu, 'selection explains the item-specific required family');
    assert.throws(() => store.reserveReview(box.board, id, { agentId: seat.id, leaseMs: 60_000,
      policy: 'any', familyPolicy: 'off' }), error => /family beta/iu.test(error.message),
    'direct reservation uses the same family requirement, even with the global family policy off');
    const submitted = store.getItem(box.board, id);
    assert.throws(() => store.verify(box.board, id, { agentId: seat.id, decision: 'ACCEPT',
      reason: store.ACCEPT_REASON, note: 'An ineligible family cannot bypass reservation with a direct verdict.',
      head: submitted.item_commit, digest: submitted.item_frozen_digest, policy: 'any', familyPolicy: 'off' }),
    error => error.code === 'REQUIRED_REVIEW_FAMILY' && /family beta/iu.test(error.message),
    'direct verdicts enforce the family requirement without relying on a prior reservation');
    assert.deepEqual(store.verdictsFor(box.board, id), [], 'a refused verdict leaves no acceptance behind');
    for (const args of [['next', '--take'], ['next', '--verify', String(id)]]) {
      const refused = await cli(box, seat.path, args);
      assert.notEqual(refused.code, 0, refused.out + refused.err);
      assert.match(refused.out + refused.err, /family beta/iu, 'CLI refusal names the required family');
      assert.equal(store.getItem(box.board, id).item_review_by, null, 'a refusal never reserves the item');
    }
  }
  const sibling = await cli(box, box.seats.sibling.path, ['next', '--verify', String(id)]);
  assert.notEqual(sibling.code, 0, 'the right family does not waive the independent-parent requirement');
  assert.equal(store.getItem(box.board, id).item_review_by, null);

  const snapshot = exportBoard(box.board);
  const replica = openBoard(':memory:', box.clock);
  t.after(() => store.closeBoard(replica));
  importBoard(replica, snapshot);
  assert.equal(store.getItem(replica, id).item_review_family, 'fAmIlY bEtA', 'the exported board retains family metadata');
  const replicaNext = store.nextFor(replica, { agentId: box.seats.outside.id, lane: 'review', verify: true,
    policy: 'any', familyPolicy: 'off' });
  assert.equal(replicaNext.item?.item_id, id, 'case-insensitive declared family matching survives board exchange');
  const taken = await cli(box, box.seats.outside.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, id);
  assert.equal(store.getItem(box.board, id).item_review_by, box.seats.outside.id, 'the eligible exact seat gets the review');
  assert.deepEqual(store.verdictsFor(box.board, id), [], 'dispatch does not invent a verdict');
}
