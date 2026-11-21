/** The store records the cited main commit on a system-actor withdraw as met, and refuses one whose commit does not carry the work [C7,#12552]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';

// fixture-subject: addItem (a store unit test of withdraw over a hand-built open item)
const SYNTHETIC_MODEL = 'Synthetic fixture model';
const COMMIT = 'a'.repeat(40);
const CAUSE = 'sentinel:met-on-main';

/** An open item, a coordinator and a seat; a commit "carries the work" only when it is COMMIT. */
function fixture(t) {
  const board = fixtureBoard(t);
  for (const id of ['coordinator', 'core-1']) store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, model: SYNTHETIC_MODEL });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Withdraw as met fixture' });
  const carries = commit => commit === COMMIT;
  const status = () => store.getItem(board, id).item_status;
  const events = () => board.db.prepare("SELECT event_by AS by, event_detail AS detail FROM event WHERE item_id = ? AND event_kind = 'withdraw'").all(id).map(row => ({ by: row.by, detail: JSON.parse(row.detail) }));
  return { board, id, carries, status, events };
}

test('store.io-board-withdraw.system-actor-as-met-names-commit: clause 1: a system-actor withdraw citing a main commit that carries the work is written as met and the withdrawn record names the commit; a coordinator withdraw names none [C7,#12552]', t => {
  const f = fixture(t);
  store.withdraw(f.board, f.id, { agentId: 'sentinel', reason: 'met on main', cause: CAUSE, metCommit: COMMIT, commitCarriesWork: f.carries });
  assert.equal(f.status(), 'withdrawn');
  assert.deepEqual(f.events(), [{ by: 'sentinel', detail: { reason: 'met on main', commit: COMMIT } }]);
  const plain = fixture(t);
  store.withdraw(plain.board, plain.id, { agentId: 'coordinator', reason: 'duplicate of another item' });
  const [recorded, ...rest] = plain.events();
  assert.equal(rest.length, 0);
  assert.equal(recorded.by, 'coordinator');
  assert.equal(recorded.detail.reason, 'duplicate of another item');
  assert.equal('commit' in recorded.detail, false);
});

test('store.io-board-withdraw.refuses-uncited-or-off-main: clause 2: a seat withdraw and a system-actor withdraw citing no commit or a commit that does not carry the work are refused as COORDINATOR_ONLY and write nothing [C7,#12552]', t => {
  const f = fixture(t);
  const before = f.board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  const refuse = why => assert.throws(() => store.withdraw(f.board, f.id, { reason: 'met on main', ...why }), { code: 'COORDINATOR_ONLY' });
  refuse({ agentId: 'core-1', cause: CAUSE, metCommit: COMMIT, commitCarriesWork: f.carries });
  refuse({ agentId: 'sentinel', cause: CAUSE, commitCarriesWork: f.carries });
  refuse({ agentId: 'sentinel', cause: CAUSE, metCommit: 'b'.repeat(40), commitCarriesWork: f.carries });
  refuse({ agentId: 'sentinel', cause: CAUSE, metCommit: COMMIT });
  assert.equal(f.status(), 'open');
  assert.equal(f.board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n, before);
});
