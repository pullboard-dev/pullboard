/** A real SQLite history delivers refused landing notices and escalates only unacknowledged failures [B3,R3,A6,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { register } from '../../../store/index.js';
import { withdraw } from '../../../store/index.js';
import { addItem } from '../../../store/index.js';
import { appendFact } from '../../../store/index.js';
import { atomic } from '../../../store/index.js';
import { logEvent } from '../../../store/index.js';
import { recordHealthFindings } from '../../../store/index.js';
import { landingFailureFindings } from '../../index.js';
import { landingFailureObservation } from '../../index.js';

/** Seed a private historical batch and use the actual health move to deliver its notices. */
function fixture(t) {
  let at = Date.parse('2026-11-02T00:00:00Z');
  const board = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  register(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = register(board, { lane: 'core', path: '/builder' });
  const item = addItem(board, { by: 'coordinator', lane: 'core', title: 'Landing result', criterion: 'The result holds.' });
  const batch = { id: 'refused-batch', state: 'ready', items: [{ id: item }], updatedAt: new Date(at).toISOString(),
    refusal: { code: 'COMMIT_HEADER_LONG', at: new Date(at).toISOString() } };
  atomic(board, () => logEvent(board, 'coordinator', 'landing_batch', null, { batch }));
  const publish = () => {
    const observation = landingFailureObservation(board);
    if (observation) recordHealthFindings(board, { agentId: 'coordinator', ...observation });
    return observation;
  };
  return { board, builder, item, batch, publish, advance: minutes => { at += minutes * 60_000; } };
}

test('a refused batch shouts its item and code, then escalates after fifteen unanswered minutes [B3,R3,A6,C7]', t => {
  const box = fixture(t);
  const revision = box.board.db.prepare('SELECT MAX(event_id) AS n FROM event').get().n;
  recordHealthFindings(box.board, { agentId: 'coordinator', observedRevision: revision,
    findings: [{ key: 'existing', cause: 'EXISTING', item: null, subject: 'another issue', title: 'waiting',
      since: box.batch.updatedAt, why: 'another cause', next: 'continue its repair', owner: { who: 'coordinator' } }] });
  assert.ok(box.publish());
  const coordinator = box.board.db.prepare("SELECT * FROM shout WHERE shout_to='coordinator' ORDER BY shout_id DESC").all();
  assert.ok(coordinator.some(row => row.shout_text.includes('#' + box.item) && row.shout_text.includes('COMMIT_HEADER_LONG')));
  assert.equal(box.publish(), null, 'an unchanged finding is not shouted twice');
  const active = JSON.parse(box.board.db.prepare("SELECT event_detail FROM event WHERE event_kind='health-scan' ORDER BY event_id DESC LIMIT 1").get().event_detail).active;
  assert.ok(active.some(row => row.key === 'existing'), 'a landing notice never clears unrelated health');
  box.advance(14);
  assert.equal(landingFailureFindings(box.board)[0].owner.who, 'coordinator');
  box.advance(1);
  box.publish();
  const person = box.board.db.prepare("SELECT * FROM shout WHERE shout_to='person'").all();
  assert.ok(person.some(row => row.shout_text.includes('#' + box.item) && row.shout_text.includes('COMMIT_HEADER_LONG')));
});

test('only an explicit coordinator acknowledgement answers a landing failure [B3,R3,A6,C7]', t => {
  const box = fixture(t); box.publish();
  appendFact(box.board, box.item, { agentId: box.builder, kind: 'note', text: 'Landing batch refused-batch: acknowledged' });
  box.advance(15);
  assert.equal(landingFailureFindings(box.board)[0].owner.who, 'person', 'a builder cannot acknowledge for the coordinator');
  appendFact(box.board, box.item, { agentId: 'coordinator', kind: 'note', text: 'Unrelated progress' });
  assert.equal(landingFailureFindings(box.board)[0].owner.who, 'person', 'unrelated coordinator activity is not an answer');
  appendFact(box.board, box.item, { agentId: 'coordinator', kind: 'note', text: 'Landing batch refused-batch: acknowledged; investigating' });
  assert.equal(landingFailureFindings(box.board)[0].owner.who, 'coordinator');
});

test('a later landing retires the failed batch instead of raising a stale exception [B3,R3,A6,C7]', t => {
  const box = fixture(t); box.publish();
  atomic(box.board, () => logEvent(box.board, 'coordinator', 'landing_batch', null,
    { batch: { ...box.batch, id: 'landed-batch', state: 'landed', refusal: null } }));
  assert.deepEqual(landingFailureFindings(box.board), []);
  box.publish();
  assert.equal(box.publish(), null);
});

test('clause 1: a refused batch whose items all landed by another path raises no finding, one still open does [B3,R3,A6,C7]', t => {
  const box = fixture(t);
  assert.equal(landingFailureFindings(box.board).length, 1, 'an unlanded item keeps the finding');
  const other = addItem(box.board, { by: 'coordinator', lane: 'core', title: 'Second', criterion: 'It holds.' });
  atomic(box.board, () => logEvent(box.board, 'coordinator', 'landing_batch', null,
    { batch: { ...box.batch, id: 'two', items: [{ id: box.item }, { id: other }] } }));
  box.board.db.prepare("UPDATE item SET item_merged_commit='abc123' WHERE item_id=?").run(box.item);
  assert.equal(landingFailureFindings(box.board).length, 1, 'one item still open keeps the finding');
  withdraw(box.board, other, { agentId: 'coordinator', reason: 'no longer needed' });
  assert.deepEqual(landingFailureFindings(box.board), [], 'every item merged or withdrawn retires the finding');
});
