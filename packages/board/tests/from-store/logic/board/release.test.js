/** Infrastructure-caused releases do not count toward the release-twice hold [C7,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { openCellBoard as openBoard } from '../../../fixtures/cell-board.js';
import { INFRA_RELEASE_ENGINE } from '../../../../../state/index.js';

const commit = 'a'.repeat(40);

/** A board with one item and two core seats. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-infra-release-'));
  const board = openBoard(':memory:');
  t.after(() => { store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const first = store.register(board, { lane: 'core', path: '/one', route: 'strong' });
  const second = store.register(board, { lane: 'core', path: '/two', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'work', criterion: 'prove it', route: 'strong' });
  const claim = agentId => store.claim(board, id, { agentId, lane: 'core', leaseMs: 7200000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit, verify: { policy: 'any', family: 'off' } } }), digest: 'digest' }) });
  /** Record that the seat's queued gate ended in infrastructure. */
  const handoffEnded = agentId => board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?,?,?,?,?)")
    .run(new Date().toISOString(), agentId, 'submit-handoff', id, JSON.stringify({ state: 'infrastructure', commit })) && undefined;
  return { board, first, second, id, claim, handoffEnded };
}

test('board.release.release-with-infra-after-infrastructure-ended: clause 1: a release with INFRA, or after an infrastructure-ended handoff, is not counted [C7,H16]', t => {
  const f = fixture(t);
  f.claim(f.first); f.handoffEnded(f.first); store.release(f.board, f.id, f.first, '', 'BLOCKED');
  f.claim(f.second); store.release(f.board, f.id, f.second, '', 'INFRA');
  f.claim(f.first); f.handoffEnded(f.first); store.release(f.board, f.id, f.first, '', 'BLOCKED');
  assert.equal(store.getItem(f.board, f.id).item_hold_reason, null);
});

test('board.release.release-twice-hold-two-infrastructure-releases: clause 2: a release-twice hold of two infrastructure releases lifts itself on the next write [C7,H16]', t => {
  const f = fixture(t);
  f.board.executionEngineVersion = INFRA_RELEASE_ENGINE - 1;
  f.claim(f.first); f.handoffEnded(f.first); store.release(f.board, f.id, f.first, '', 'BLOCKED');
  f.claim(f.second); f.handoffEnded(f.second); store.release(f.board, f.id, f.second, '', 'BLOCKED');
  assert.match(store.getItem(f.board, f.id).item_hold_reason, /Released twice/u);
  delete f.board.executionEngineVersion;
  store.atomic(f.board, () => store.logEvent(f.board, 'coordinator', 'shout', f.id, {}));
  const held = store.getItem(f.board, f.id);
  assert.equal(held.item_hold_reason, null);
  assert.ok(f.board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='unhold_item' AND event_detail LIKE '%infrastructure%'").get(f.id));
});

test('board.release.two-blocked-releases-with-infrastructure-cause: clause 3: two BLOCKED releases with no infrastructure cause still hold the item [C7,H16]', t => {
  const f = fixture(t);
  f.claim(f.first); store.release(f.board, f.id, f.first, '', 'BLOCKED');
  f.claim(f.second); store.release(f.board, f.id, f.second, '', 'BLOCKED');
  assert.match(store.getItem(f.board, f.id).item_hold_reason, /Released twice/u);
});

test('board.release.two-blocked-releases-naming-structured-blockedon: clause 1: two BLOCKED releases naming a structured blockedOn place no released-twice hold [C7]', t => {
  const f = fixture(t);
  const other = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'blocker', criterion: 'prove it', route: 'strong' }); // fixture-subject: addItem
  f.claim(f.first); store.release(f.board, f.id, f.first, '', { blockedOn: [other] }, 'BLOCKED');
  f.board.db.prepare('UPDATE item SET item_after=? WHERE item_id=?').run('', f.id);
  store.withdraw(f.board, other, { agentId: 'coordinator', reason: 'the blocker is gone, so the second claim is allowed' });
  const again = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'second blocker', criterion: 'prove it', route: 'strong' }); // fixture-subject: addItem
  f.claim(f.second); store.release(f.board, f.id, f.second, '', { blockedOn: [again] }, 'BLOCKED');
  assert.equal(store.getItem(f.board, f.id).item_hold_reason, null);
});

test('board.release.two-blocked-releases-whose-note-carries: clause 1: two BLOCKED releases whose note carries an infrastructure code place no released-twice hold [C7]', t => {
  const f = fixture(t);
  f.claim(f.first); store.release(f.board, f.id, f.first, 'GATE_INFRA_EXHAUSTED on the runner', 'BLOCKED');
  f.claim(f.second); store.release(f.board, f.id, f.second, 'DATABASE_LOCKED twice', 'BLOCKED');
  assert.equal(store.getItem(f.board, f.id).item_hold_reason, null);
});
