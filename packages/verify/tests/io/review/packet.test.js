/** The review packet keeps a numbered clause whole when its text holds digit-period prose, and still splits free text [V4,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { buildReviewPacket } from '../../../src/io/review/packet.js';

/** A scratch repository with two commits, so the packet has a base and a head to diff. */
function scratch(t) {
  const graph = fixtureCommittedGraph('pullboard-review-packet-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  graph.put('a.txt', 'one\n');
  graph.commit();
  graph.put('a.txt', 'two\n');
  return { root: graph.root, head: graph.commit() };
}

/** The packet's clauses for an item whose frozen criterion is `criterion`. */
function clausesOf(t, criterion) {
  const { root, head } = scratch(t);
  const item = { item_id: 11015, item_commit: head, item_criterion: criterion, item_frozen: JSON.stringify({ criterion }) };
  const submit = { commit: head, gateGreen: true, submissionProof: {} };
  return buildReviewPacket(root, { item, submit, receipts: [], baseline: null, mainRuns: [], thread: [] }, { errors: [] }).clauses;
}

test('verify.review-packet.numbered-clause-with-inner-periods: clause 1: a numbered clause whose text holds "is 3. Not 4." is one clause numbered 1, without its leading marker, of kind test [V4,C7]', t => {
  const clauses = clausesOf(t, '1. m.js exports c equal to 3, e.g. c is 3. Not 4. Never a string. [test]');
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0].n, 1);
  assert.equal(clauses[0].text, 'm.js exports c equal to 3, e.g. c is 3. Not 4. Never a string. [test]');
  assert.equal(clauses[0].kind, 'test');
});

test('verify.review-packet.three-clauses-with-inner-periods: clause 2: a three-clause numbered criterion with digit-period prose yields exactly three packet clauses numbered 1 to 3 [V4,C7]', t => {
  const clauses = clausesOf(t, '1. c is 3. Not 4. [test] 2. d is 5. Not 6. [command] 3. e holds. [reasoning]');
  assert.deepEqual(clauses.map(clause => [clause.n, clause.kind]), [[1, 'test'], [2, 'command'], [3, 'reasoning']]);
  assert.deepEqual(clauses.map(clause => clause.text), ['c is 3. Not 4. [test]', 'd is 5. Not 6. [command]', 'e holds. [reasoning]']);
});

test('verify.review-packet.free-text-still-splits: clause 2: a free-text criterion with no leading number still splits at sentence ends [V4,C7]', t => {
  const clauses = clausesOf(t, 'The page shows the total. It updates on edit. Nothing else changes.');
  assert.deepEqual(clauses.map(clause => clause.text), ['The page shows the total.', 'It updates on edit.', 'Nothing else changes.']);
});
