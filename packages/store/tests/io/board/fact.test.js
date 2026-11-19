/** The seat that recorded an item's accept corrects its note with a superseding fact; any other seat is refused [C7,#11787]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';
import { temporaryRepository } from '../../fixtures/submit.js';

const COMMIT = 'a'.repeat(40);
const TRUNK = 'b'.repeat(40);
const POLICY = { version: 1, commit: COMMIT, verify: { policy: 'any', family: 'off' } };
const PROOF = { version: 1, files: [], full: false, deferred: true, reason: 'synthetic board-state fixture; no gate execution' };

/** A real board file with a submitted item, the seat that accepts it and a second reviewing seat that did not. */
function fixture(t) {
  const repo = temporaryRepository(t, 'pullboard-fact-accept-');
  mkdirSync(join(repo, '.git', 'pullboard'));
  const board = cellBoard(t, join(repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date() }, { real: true, gitRoot: repo });
  const coordinator = cellSeat(board, { lane: 'coordinator', path: '/repo' });
  const builder = cellSeat(board, { lane: 'core', path: '/builder', family: 'Fact Builder Vendor', route: 'mid' });
  const reviewer = cellSeat(board, { lane: 'review', path: '/reviewer', family: 'Fact Reviewer Vendor', route: 'strong' });
  const other = cellSeat(board, { lane: 'review', path: '/other', family: 'Fact Other Vendor', route: 'strong' });
  const id = cellItem(board, { lane: 'core', title: 'accepted item', criterion: 'one', route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' }).item_id;
  const freeze = item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: POLICY }), digest: 'digest:fact-accept' });
  store.claim(board, id, { agentId: builder.id, lane: 'core', leaseMs: 7_200_000, freeze });
  store.writeBoardCommand(board, 'submit', [id, { agentId: builder.id, commit: COMMIT, tree: COMMIT, submissionProof: PROOF }], builder.id);
  board.executionEngineVersion = ENGINE_VERSION;
  const item = store.getItem(board, id);
  store.verify(board, id, { agentId: reviewer.id, decision: 'ACCEPT', head: item.item_commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off',
    note: 'Synthetic fixture accept: read the diff against the bar.', review: { commit: item.item_commit, head: item.item_commit, trunk: TRUNK, paths: [] } });
  const move = store.itemThread(board, id).find(entry => entry.type === 'move' && entry.kind === 'accept');
  return { board, id, coordinator, reviewer, other, accept: move };
}

test('store.board-fact.reviewer-corrects-accept-note: clause 1: appendFact records a note whose supersedes names the item\'s accept move when the caller recorded that accept, and the thread shows it [C7,#11787]', t => {
  const f = fixture(t);
  assert.equal(f.accept.by, f.reviewer.id, 'the fixture accept is the reviewer\'s');
  const fact = store.appendFact(f.board, f.id, { agentId: f.reviewer.id, kind: 'note', text: 'Correction: the earlier accept note was wrong.', supersedes: String(f.accept.eventId) });
  assert.equal(fact.supersedes, String(f.accept.eventId));
  const thread = store.itemThread(f.board, f.id);
  assert.equal(thread.find(entry => entry.type === 'fact' && entry.id === fact.id)?.supersedes, String(f.accept.eventId), 'the thread shows the fact as superseding the accept');
  assert.ok(thread.some(entry => entry.type === 'move' && entry.kind === 'accept' && entry.eventId === f.accept.eventId), 'the original accept stays in the record');
});

test('store.board-fact.other-seat-cannot-correct: clause 2: another seat that is not the coordinator is refused FACT_JUDGEMENT, and a supersedes naming no move or fact is refused NO_FACT [C7,#11787]', t => {
  const f = fixture(t);
  assert.throws(() => store.appendFact(f.board, f.id, { agentId: f.other.id, kind: 'note', text: 'Correction from a seat that did not accept.', supersedes: String(f.accept.eventId) }), { code: 'FACT_JUDGEMENT' });
  assert.throws(() => store.appendFact(f.board, f.id, { agentId: f.coordinator.id, kind: 'note', text: 'Correction of nothing.', supersedes: '999999' }), { code: 'NO_FACT' });
  assert.equal(store.itemThread(f.board, f.id).filter(entry => entry.type === 'fact' && entry.supersedes !== null).length, 0, 'a refusal records nothing');
});
