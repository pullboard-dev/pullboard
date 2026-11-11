/** @pullboard-test-input source-tree */
/** Review routing never offers an item to a seat that shares a parent session with its author [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { board as store } from '../../index.js';
import { fixtureBoard } from '../../../cli/tests/fixtures/board.js';
import { submitFixture } from '../../../cli/tests/fixtures/board/submit.js';

const SYNTHETIC_MODEL = 'Synthetic fixture model';

const LEASE = 3_600_000;
const freeze = () => ({ text: '{}', digest: 'synthetic-session-bar' });

/** Seats core-1 (builder) and core-2 in one parent session, core-4 in another, plus the coordinator. */
function fixture(t) {
  const board = fixtureBoard(t);
  const join = (id, parent) => store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`,
    family: 'claude', parentDigest: parent.repeat(64), sessionDigest: parent.repeat(64), model: SYNTHETIC_MODEL });
  join('coordinator', 'e');
  join('core-1', 'a');
  join('core-2', 'a');
  join('core-4', 'c');
  const item = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Session routing fixture' });
  store.claim(board, item, { agentId: 'core-1', lane: 'core', leaseMs: LEASE, freeze });
  submitFixture(board, item, { agentId: 'core-1', commit: String(item).padStart(40, 'a'), tree: 'b'.repeat(40) });
  /** What next --verify would offer this seat. */
  const offer = (agentId) => store.nextFor(board, { agentId, lane: 'core', verify: true, policy: 'any', familyPolicy: 'off' });
  return { board, item, offer };
}

test('clause 1: next --verify skips a reviewer seat whose session is an author session of the item [C7]', (t) => {
  const f = fixture(t);
  assert.equal(f.offer('core-2').item, null, 'the seat sharing the builder session is never offered the item');
  assert.equal(f.offer('core-4').item?.item_id, f.item, 'a seat from another session is offered it');
});

test('clause 2: next-idle names the item and REVIEWER_SAME_SESSION when every awake reviewer shares the author session [C7]', (t) => {
  const f = fixture(t);
  const idle = f.offer('core-2');
  assert.equal(idle.item, null);
  assert.match(idle.reasons.join('\n'), new RegExp(`REVIEWER_SAME_SESSION: #${f.item}\\b`, 'u'));
  const ledger = store.nextFor(f.board, { agentId: 'core-4', lane: 'core', verify: true, policy: 'any', familyPolicy: 'off', sessionIds: [f.item] });
  assert.match(ledger.reasons.join('\n'), new RegExp(`REVIEWER_SAME_SESSION: #${f.item}\\b`, 'u'), 'an item the caller marks as its session\'s is named too');
  const other = store.nextFor(f.board, { agentId: 'core-4', lane: 'core', verify: true, policy: 'any', familyPolicy: 'off', skipIds: [f.item] });
  assert.doesNotMatch(other.reasons.join('\n'), /REVIEWER_SAME_SESSION/u, 'an item skipped for any other reason is never labelled a shared session');
});
