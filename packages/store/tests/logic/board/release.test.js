/** Infrastructure-caused releases do not count toward the release-twice hold [C7,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { openCellBoard as openBoard } from '../../fixtures/cell.js';
import { INFRA_RELEASE_ENGINE } from '../../../../state/index.js';

const commit = 'a'.repeat(40);

/** A board with one item and two core seats. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-infra-release-'));
  const board = openBoard(join(dir, 'board.sqlite'));
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

test('clause 1: a release with INFRA, or after an infrastructure-ended handoff, is not counted [C7,H16]', t => {
  const f = fixture(t);
  f.claim(f.first); f.handoffEnded(f.first); store.release(f.board, f.id, f.first, '', 'BLOCKED');
  f.claim(f.second); store.release(f.board, f.id, f.second, '', 'INFRA');
  f.claim(f.first); f.handoffEnded(f.first); store.release(f.board, f.id, f.first, '', 'BLOCKED');
  assert.equal(store.getItem(f.board, f.id).item_hold_reason, null);
});

test('clause 2: a release-twice hold of two infrastructure releases lifts itself on the next write [C7,H16]', t => {
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

test('clause 3: two BLOCKED releases with no infrastructure cause still hold the item [C7,H16]', t => {
  const f = fixture(t);
  f.claim(f.first); store.release(f.board, f.id, f.first, '', 'BLOCKED');
  f.claim(f.second); store.release(f.board, f.id, f.second, '', 'BLOCKED');
  assert.match(store.getItem(f.board, f.id).item_hold_reason, /Released twice/u);
});
